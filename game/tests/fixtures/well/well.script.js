// The well — E spins the ball over it, and E again stops it.
export default function (object) {
  object.action({ name: 'spin', label: 'Spin', stop: 'Stop' }, {
    start: (run) => run.play('spin', { loop: true }),
    stop: (run) => run.end(),
  });
}
