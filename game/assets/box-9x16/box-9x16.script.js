// A screen in a phone's shape: the Izhevsk bridge film on its front, over and
// over, from the moment it is placed. It starts silent; its sound, once on, is
// for whoever walks up to it - faint at 10 m, gone at 12, full within a metre
// or so - so a room with it in is quiet until you come near.
//
// The film is drawn as an OLED panel shows it - each of its pixels three
// dots on black, live, over the plain picture (ASSET_CONTRACT.md, Screens).
//
// E unmutes it, and E again mutes it where the picture is. Sounding is a run,
// so the key reads "Mute" for as long as it lasts.
export default function (object) {
  const screen = object.video('izhevsk-bridge.webm', { material: 'screen', loop: true, muted: true, reach: 12, emitters: { look: 'oled' } });
  object.action({ name: 'unmute', label: 'Unmute', stop: 'Mute', radius: 4 }, {
    start() {
      screen.muted = false;
      return new Promise(() => {});
    },
    stop(run) {
      screen.muted = true;
      run.end();
    },
  });
}
