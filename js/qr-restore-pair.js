// node-qrcode (byte mode, optical transfer) just replaced QRCode: stash it, then restore the pairing one.
window.BeamByteQR = window.QRCode; window.QRCode = window.BeamPairQR;
