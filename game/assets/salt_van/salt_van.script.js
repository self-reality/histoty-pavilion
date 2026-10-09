// salt-pavilion's ship, parked: E takes the player to the Salt pavilion, in
// this tab - they are leaving for it, not opening a reference beside it.
export default function (object) {
  object.action({ name: 'visit', label: 'Visit Salt', radius: 4 }, {
    async start(run) {
      const answer = await run.menu({
        text: 'You are going to enter the Salt pavilion inside the disco ball at salt.singularitymuseum.com.',
        buttons: ['ACCEPT', 'BACK'],
      });
      if (answer === 'ACCEPT') object.open('https://salt.singularitymuseum.com/');
    },
  });
}
