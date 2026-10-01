// motion-capture-4 writes this file on every export until this line is deleted.
// g-man-dance — what it does. The API is section 6 of the asset kit's ASSET_CONTRACT.md.
export default function (object) {
  object.action({ name: 'dance', label: 'Dance', stop: 'Stop', shared: true }, {
    start: (run) => run.play('keep_it_gangsta_3', { loop: false, from: run.age }),
    stop: (run) => run.end(),
  });
}
