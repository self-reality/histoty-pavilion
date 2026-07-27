# Get the tent's transform — least-effort (no code changes, no publish)

The tent lives in the **PlayCanvas Editor** scene (cloud), so grab it from the running scene:

1. In the PlayCanvas Editor, click **Launch** (▶). A new browser tab runs the scene.
2. Open the console (**F12** / Cmd-Opt-J).
3. Paste this one line and hit Enter:

```js
(()=>{const R=pc.Application.getApplication().root;const g=e=>{const p=e.getPosition(),r=e.getEulerAngles(),s=e.getLocalScale();return{name:e.name,pos:[+p.x.toFixed(3),+p.y.toFixed(3),+p.z.toFixed(3)],rot:[+r.x.toFixed(2),+r.y.toFixed(2),+r.z.toFixed(2)],scale:[+s.x.toFixed(3),+s.y.toFixed(3),+s.z.toFixed(3)]};};const hits=R.find(e=>/tent/i.test(e.name));const out=hits.length?hits.map(g):R.children.map(c=>c.name);copy(JSON.stringify(out,null,2));console.log(out);})()
```

4. It's now on your **clipboard** (`copy()` did that) — paste it back to me in chat.

- If it finds the tent → you get its name + position/rotation/scale. I bake it into the manifest.
- If it prints a list of **names** instead → the tent isn't named "tent"; paste the list and I'll spot it,
  then send you a two-word tweak to grab that one.

## Alternative (more effort, skip unless the above fails)
Make the project public / publish the build and send me the URL — I parse the scene JSON from the
build. Works, but it's slower and less reliable than the console line above.
