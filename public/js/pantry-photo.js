/* OpenVibe.Food — "Add from a photo or a receipt" on /pantry: shrink the chosen photo on the device (at most 1280 px,
   JPEG) and put it in the form as a data URL, so the server never handles a full-size camera file. */
(function () {
    'use strict';
    var file = document.getElementById('photo-file');
    var data = document.getElementById('photo-data');
    var send = document.getElementById('photo-send');
    if (!file || !data || !send || !window.FileReader) return;
    var MAX = 1280;
    file.addEventListener('change', function () {
        send.disabled = true;
        data.value = '';
        var f = file.files && file.files[0];
        if (!f || !/^image\//.test(f.type)) return;
        send.textContent = 'Preparing the photo…';
        var reader = new FileReader();
        var img = new Image();
        img.onload = function () {
            var scale = Math.min(1, MAX / Math.max(img.naturalWidth, img.naturalHeight));
            var c = document.createElement('canvas');
            c.width = Math.max(1, Math.round(img.naturalWidth * scale));
            c.height = Math.max(1, Math.round(img.naturalHeight * scale));
            c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
            data.value = c.toDataURL('image/jpeg', 0.82);
            send.disabled = false;
            send.textContent = 'Read the photo';
        };
        img.onerror = function () { send.textContent = 'That file is not a photo this browser can open'; };
        // A data: URL (Food's CSP allows data: images, not blob:).
        reader.onload = function () { img.src = reader.result; };
        reader.readAsDataURL(f);
    });
    document.getElementById('photo-form').addEventListener('submit', function () { send.disabled = true; send.textContent = 'Reading…'; });
})();
