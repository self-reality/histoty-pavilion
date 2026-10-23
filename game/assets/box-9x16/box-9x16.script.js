// A screen in a phone's shape: the Izhevsk bridge film on its front, over and
// over, from the moment it is placed. Its sound is for whoever walks up to it -
// faint at 10 m, gone at 12, full within a metre or so - so a room with it in
// is quiet until you come near.
//
// E mutes it, and E again brings the sound back where the picture is. Muted is
// a run, so the key reads "Unmute" for as long as it lasts.
export default function (object) {
  const screen = object.video('izhevsk-bridge.webm', { material: 'screen', loop: true, muted: false, reach: 12 });
  object.action({ name: 'mute', label: 'Mute', stop: 'Unmute', radius: 4 }, {
    start() {
      screen.muted = true;
      return new Promise(() => {});
    },
    stop(run) {
      screen.muted = false;
      run.end();
    },
  });
}
