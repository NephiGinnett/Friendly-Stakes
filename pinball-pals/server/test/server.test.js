import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import { once } from "node:events";
import { config } from "../src/config.js";
import { Store, findSpecies } from "../src/state.js";
import { Hub } from "../src/hub.js";

const connect = async (hub, player, msgs = []) => {
  const port = hub.tcp.address().port;
  const sock = net.connect(port, "127.0.0.1");
  await once(sock, "connect");
  const lines = [];
  let buf = "";
  sock.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (m) => sock.write(JSON.stringify(m) + "\n");
  send({ t: "hello", token: config.players[player].token, player, field: config.players[player].field, gameCode: "BPPE" });
  msgs.forEach(send);
  return { sock, send, lines };
};
const wait = (ms = 80) => new Promise((r) => setTimeout(r, ms));

test("union merge: state only goes up, firstBy never changes", () => {
  const s = new Store(":memory:");
  s.apply("clara", 98, "seen");
  assert.equal(s.row(98).state, "seen");
  s.apply("zoe", 98, "caught");
  assert.equal(s.row(98).first_by, "zoe");
  s.apply("clara", 98, "caught");                  // later catch by the other player
  assert.equal(s.row(98).first_by, "zoe");
  assert.equal(s.apply("clara", 98, "seen"), null);// downgrade ignored
  assert.equal(s.row(98).state, "caught");
  assert.deepEqual(s.row(98).catches, { clara: 2, zoe: 2 });
});

test("snapshot counts but is quiet; dex events are loud and credited", async () => {
  config.tcpPort = 0;
  const store = new Store(":memory:");
  const hub = new Hub(store);
  hub.listenTcp(0);
  const events = [];
  hub.on("catch", (e) => events.push(e));
  const dex = new Array(205).fill(0); dex[0] = 2; dex[1] = 1;
  const z = await connect(hub, "zoe", [{ t: "snapshot", dex }]);
  await wait();
  assert.equal(hub.view().caught, 1);
  assert.equal(hub.view().seen, 1);
  assert.equal(events.length, 0, "snapshot must not celebrate");
  const c = await connect(hub, "clara", [{ t: "dex", slot: 98, state: "caught" }]);
  await wait();
  assert.equal(events.length, 1);
  assert.equal(events[0].by, "clara");
  assert.equal(events[0].name, "Wailmer");
  assert.equal(events[0].first, true);
  assert.equal(hub.view().tally.clara, 1);
  assert.deepEqual(hub.online(), { zoe: true, clara: true });
  assert.ok(z.lines.some((l) => l.t === "welcome"));
  z.sock.destroy(); c.sock.destroy();
  await wait();
  assert.deepEqual(hub.online(), { zoe: false, clara: false });
  hub.close();
});

test("bad token and wrong game are rejected", async () => {
  const hub = new Hub(new Store(":memory:"));
  hub.listenTcp(0);
  const port = hub.tcp.address().port;
  for (const hello of [{ t: "hello", token: "nope" }, { t: "hello", token: config.players.zoe.token, gameCode: "AXVE" }]) {
    const sock = net.connect(port, "127.0.0.1");
    await once(sock, "connect");
    sock.resume();
    sock.write(JSON.stringify(hello) + "\n");
    await once(sock, "close");
  }
  assert.deepEqual(hub.online(), { zoe: false, clara: false });
  hub.close();
});

test("bounty hit is flagged and cleared; milestones fire once", () => {
  const store = new Store(":memory:");
  const hub = new Hub(store);
  const sent = [];
  hub.push = (m) => sent.push(m);
  store.setBounty(10);
  hub.announce([store.apply("zoe", 10, "caught")]);
  assert.equal(sent.find((m) => m.type === "catch").isBounty, true);
  assert.equal(store.meta.bounty, null);
  for (let i = 0; i < 60; i++) hub.announce([store.apply("clara", 100 + (i % 100), "caught")].filter(Boolean));
  assert.equal(sent.filter((m) => m.type === "milestone" && m.pct === 25).length, 1);
});

test("chat lookup accepts names and national numbers", () => {
  assert.equal(findSpecies("wailmer").slot, 98);
  assert.equal(findSpecies("#320").name, "Wailmer");
  assert.equal(findSpecies("pika").name, "Pikachu");
  assert.equal(findSpecies("zzz"), null);
});
