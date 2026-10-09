// A mirror ball on its motor: it goes round the rod it hangs from, slowly and
// at one speed, and never stops. Two turns a minute is what the motors sold
// for a ball this size do - slow enough that the facets read one by one, fast
// enough that the spots they throw cross a room.
export default function (object) {
  const turnsPerMinute = 2;
  let angle = 0;
  object.on('tick', (dt) => {
    angle = (angle + turnsPerMinute * 6 * dt) % 360;
    object.turn([0, angle, 0]);
  });
}
