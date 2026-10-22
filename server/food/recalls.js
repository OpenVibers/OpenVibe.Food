'use strict';

/**
 * Food recalls: the FDA's food enforcement reports, read from OpenVibe.Sources (source openfda-food-enforcement,
 * category food), never from the FDA. Sources fetches openFDA once a day under its robots and terms checks and keeps
 * each report as an item; Food follows Sources' change feed (openvibe-publishing/ingest: the cursor in
 * food_ingest_cursor, one transaction per page) and keeps one row per recall in food_recalls, exactly as the report
 * states it. An item Sources removes (a takedown, a licence change) is deleted here.
 *
 * The reports are public domain (CC0). openFDA's terms ask that a use not imply FDA endorsement and say the data are
 * unvalidated and not for medical decisions: every page that shows a recall carries NOTE.
 *
 * Pulls 30 seconds after start and then hourly. Off without OV_SOURCES_INTERNAL_URL and the OAuth client secret (a
 * test passes its own source).
 */
const ingest = require('openvibe-publishing/ingest');

const SOURCE_KEY = 'openfda-food-enforcement';
const CURSOR = 'sources.food.after';
const EVERY_MS = 60 * 60 * 1000;
const FIRST_MS = 30 * 1000;
const CLASSES = ['Class I', 'Class II', 'Class III'];
// What each class means, in the FDA's words (fda.gov, "Recalls Background and Definitions").
const CLASS_TEXT = {
    'Class I': 'a reasonable probability that the product will cause serious adverse health consequences or death',
    'Class II': 'the product may cause temporary or medically reversible adverse health consequences, or the chance of serious harm is remote',
    'Class III': 'the product is not likely to cause adverse health consequences',
};
const NOTE = 'Recalls are the FDA\'s food enforcement reports through openFDA (public domain). They are not validated by openFDA, not for medical decisions, and OpenVibe.Food is not endorsed by the FDA.';
const FDA_REPORTS = 'https://www.accessdata.fda.gov/scripts/ires/index.cfm';

const text = (v, max) => (v == null || v === '' ? null : String(v).replace(/\s+/g, ' ').trim().slice(0, max) || null);
/** The reports' YYYYMMDD → YYYY-MM-DD, or null. */
function day(v) {
    const m = /^(\d{4})(\d{2})(\d{2})$/.exec(String(v == null ? '' : v).trim());
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12 || Number(m[3]) < 1 || Number(m[3]) > 31) return null;
    return `${m[1]}-${m[2]}-${m[3]}`;
}
const NUMBER_RE = /^[A-Z]-\d{3,5}-\d{4}$/;

/** A Sources item → a food_recalls row, or null when it is not a recall this page can show. */
function rowOf(item) {
    const f = (item && item.fields) || {};
    const number = text(item && item.identity, 40);
    const product = text(item && item.title, 2000);
    if (!number || !NUMBER_RE.test(number) || !product) return null;
    return {
        recall_number: number,
        item_id: String(item.id),
        revision: Number(item.revision) || 1,
        product,
        reason: text(item.summary, 2000),
        firm: text(f.recalling_firm, 300),
        classification: CLASSES.includes(f.classification) ? f.classification : null,
        status: text(f.status, 40),
        state: text(f.state, 40),
        distribution: text(f.distribution_pattern, 2000),
        voluntary: text(f.voluntary_mandated, 120),
        initiated_on: day(f.recall_initiation_date),
        reported_on: day(f.report_date),
        retrieved_at: (item.provenance && item.provenance.retrieved_at) || new Date(0).toISOString(),
    };
}

function createRecalls({ config, s, fetchImpl = globalThis.fetch, log = console, source = null }) {
    const url = String((config.sources && config.sources.internalUrl) || '').replace(/\/+$/, '');
    const client = source || (url && config.oauth.clientSecret
        ? ingest.createSourcesClient({ config: { ...config, sources: { internalUrl: url, category: 'food' } }, fetchImpl })
        : null);
    const cursor = ingest.createChangeCursor(s.db, { prefix: 'food', now: s.now });
    const stats = { pulls: 0, applied: 0, removed: 0, last_at: null, last_error: null };
    let timer = null;
    let first = null;
    let running = false;

    async function apply(item, t) {
        if (!item || item.source_key !== SOURCE_KEY || item.kind !== 'recall') return 'hold';
        if (item.removed) {
            await t.query('DELETE FROM food_recalls WHERE item_id = $1', [String(item.id)]);
            return 'removed';
        }
        const row = rowOf(item);
        if (!row) return 'hold';
        const cols = Object.keys(row);
        // A replayed page (or an older revision arriving late) never takes a row back.
        await t.query(`INSERT INTO food_recalls (${cols.join(', ')}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(', ')})
            ON CONFLICT (recall_number) DO UPDATE SET ${cols.filter((c) => c !== 'recall_number').map((c) => `${c} = EXCLUDED.${c}`).join(', ')}
            WHERE food_recalls.item_id <> EXCLUDED.item_id OR food_recalls.revision <= EXCLUDED.revision`, cols.map((c) => row[c]));
        return 'applied';
    }

    /** Follow Sources' change feed to its end. Never throws: the caller is a timer or a test. */
    async function pull() {
        if (!client || running) return { skipped: true };
        running = true;
        try {
            const out = await ingest.pullChanges({ db: s.db, cursor, source: client, name: CURSOR, apply });
            stats.pulls++;
            stats.applied += out.applied;
            stats.removed += out.removed;
            stats.last_at = s.iso();
            stats.last_error = null;
            if (out.applied || out.removed) log.log(`[Recalls] ${out.applied} recalls updated, ${out.removed} removed (Sources cursor ${out.after})`);
            return out;
        } catch (err) {
            stats.last_error = text(err && err.message, 300);
            log.warn(`[Recalls] pull from OpenVibe.Sources failed: ${stats.last_error}`);
            return { error: stats.last_error };
        } finally { running = false; }
    }

    const shape = (r) => (r ? { ...r, class_text: CLASS_TEXT[r.classification] || null } : null);

    /** Filters shared by list() and count(): words (product, firm, reason), a class, a state. */
    function where({ q, classification, state } = {}) {
        const clauses = [];
        const args = [];
        if (q) {
            args.push(`%${String(q).toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
            clauses.push(`(lower(product) LIKE $${args.length} OR lower(coalesce(firm, '')) LIKE $${args.length} OR lower(coalesce(reason, '')) LIKE $${args.length})`);
        }
        if (CLASSES.includes(classification)) { args.push(classification); clauses.push(`classification = $${args.length}`); }
        if (state) { args.push(String(state)); clauses.push(`state = $${args.length}`); }
        return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', args };
    }

    return {
        enabled: Boolean(client),
        stats,
        pull,
        apply,
        /** Newest report first. */
        async list({ q = null, classification = null, state = null, limit = 50, offset = 0 } = {}) {
            const w = where({ q, classification, state });
            const rows = await s.db.many(`SELECT * FROM food_recalls ${w.sql} ORDER BY reported_on DESC NULLS LAST, recall_number DESC LIMIT $${w.args.length + 1} OFFSET $${w.args.length + 2}`,
                [...w.args, Math.min(Math.max(1, limit), 200), Math.max(0, offset)]);
            return rows.map(shape);
        },
        async count(filters = {}) {
            const w = where(filters);
            return Number(await s.db.value(`SELECT count(*) FROM food_recalls ${w.sql}`, w.args)) || 0;
        },
        async get(number) { return NUMBER_RE.test(String(number)) ? shape(await s.db.maybe('SELECT * FROM food_recalls WHERE recall_number = $1', [String(number)])) : null; },
        /** The states the recalling firms are in, most recalls first (the filter's choices). */
        async states() { return s.db.many('SELECT state, count(*)::int AS n FROM food_recalls WHERE state IS NOT NULL GROUP BY state ORDER BY n DESC, state'); },
        /** Every recall number with its report date (the sitemap). */
        async numbers() { return s.db.many('SELECT recall_number, reported_on FROM food_recalls ORDER BY reported_on DESC NULLS LAST, recall_number DESC LIMIT 5000'); },
        start() {
            if (!client || timer) return false;
            timer = setInterval(() => { pull().catch(() => {}); }, EVERY_MS);
            timer.unref();
            first = setTimeout(() => { pull().catch(() => {}); }, FIRST_MS);
            first.unref();
            return true;
        },
        stop() { clearInterval(timer); clearTimeout(first); timer = null; first = null; },
    };
}

module.exports = { createRecalls, rowOf, day, SOURCE_KEY, CLASSES, CLASS_TEXT, NOTE, FDA_REPORTS };
