/* OpenVibe.Food — "Scan with camera" on /pantry: the browser's own barcode reader (BarcodeDetector), where it has one.
   The camera picture never leaves the device: only the number read from it goes to /pantry/barcode, as if typed. */
(function () {
    'use strict';
    var btn = document.getElementById('bc-scan');
    var video = document.getElementById('bc-video');
    var input = document.getElementById('bc');
    if (!btn || !video || !input || !('BarcodeDetector' in window) || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    btn.hidden = false;
    var stream = null;
    var timer = null;
    function stop() {
        if (timer) { clearInterval(timer); timer = null; }
        if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
        video.hidden = true;
        btn.textContent = 'Scan with camera';
    }
    btn.addEventListener('click', function () {
        if (stream) { stop(); return; }
        var detector = new window.BarcodeDetector({ formats: ['ean_13', 'ean_8', 'upc_a'] });
        navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' }, audio: false }).then(function (s) {
            stream = s;
            video.srcObject = s;
            video.hidden = false;
            btn.textContent = 'Stop the camera';
            return video.play();
        }).then(function () {
            timer = setInterval(function () {
                detector.detect(video).then(function (codes) {
                    var c = codes && codes[0] && codes[0].rawValue;
                    if (!c) return;
                    stop();
                    input.value = c;
                    input.form.submit();
                }).catch(function () { /* the next frame */ });
            }, 300);
        }).catch(function () {
            stop();
            btn.textContent = 'Camera not available: type the number';
            btn.disabled = true;
        });
    });
    window.addEventListener('pagehide', stop);
})();
