/* Pantry photo: the shared picker chooses locally; only a reduced JPEG goes to Food. */
(function () {
    'use strict';
    var root = document.getElementById('photo-picker');
    var data = document.getElementById('photo-data');
    var send = document.getElementById('photo-send');
    var error = document.getElementById('photo-error');
    var form = document.getElementById('photo-form');
    if (!root || !data || !send || !error || !form || !window.OVUpload || !window.FileReader) return;

    var MAX_SIDE = 1280;
    var MAX_SOURCE = 20 * 1024 * 1024;
    var MAX_RESULT = 3500000;
    var row = null;
    var generation = 0;
    function fail(message) {
        data.value = '';
        send.disabled = true;
        send.textContent = 'Read the photo';
        error.textContent = message;
        error.hidden = false;
    }
    function clear() {
        generation++;
        row = null;
        data.value = '';
        send.disabled = true;
    }
    var pick = OVUpload.picker(root, {
        label: 'Choose a cupboard photo or receipt', accept: 'image/*', multiple: false,
        onRemove: clear,
        onFile: function (file, nextRow) {
            if (row) { row.dispatchEvent(new Event('remove')); row.remove(); }
            row = nextRow;
            var current = ++generation;
            data.value = '';
            send.disabled = true;
            error.hidden = true;
            if (!/^image\//.test(file.type)) return fail('Choose a photo or screenshot.');
            if (file.size > MAX_SOURCE) return fail('Choose an image under 20 MB.');
            send.textContent = 'Preparing the photo…';
            var reader = new FileReader();
            var img = new Image();
            img.onload = function () {
                if (current !== generation) return;
                try {
                    var scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
                    var canvas = document.createElement('canvas');
                    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
                    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
                    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
                    var reduced = canvas.toDataURL('image/jpeg', 0.82);
                    if (reduced.length > MAX_RESULT) return fail('The prepared photo is over 3.5 MB. Choose a smaller image.');
                    data.value = reduced;
                    send.disabled = false;
                    send.textContent = 'Read the photo';
                } catch (_) { fail('This browser could not prepare that photo. Choose another image.'); }
            };
            img.onerror = function () { if (current === generation) fail('That file is not a photo this browser can open.'); };
            reader.onerror = function () { if (current === generation) fail('The photo could not be read. Choose it again.'); };
            reader.onload = function () { if (current === generation) img.src = reader.result; };
            reader.readAsDataURL(file);
        }
    });
    pick.input.setAttribute('capture', 'environment');
    pick.input.setAttribute('aria-describedby', 'photo-note');
    form.addEventListener('submit', function () { send.disabled = true; send.textContent = 'Reading…'; });
})();
