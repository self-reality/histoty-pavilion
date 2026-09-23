// The well — E spins the ball over it until E again.
export default function (object) {
  object.action({ name: 'spin', label: 'Spin', stop: 'Stop' },
    (run) => run.play('spin', { loop: true }));
}
