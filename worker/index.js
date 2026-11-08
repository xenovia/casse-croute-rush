// Casse-Croûte Rush : serveur des parties en ligne.
// Le site (fichiers statiques) est servi par "assets"; ce Worker ne reçoit que ce qui n'est pas un fichier.
//   /ws?room=1234&role=host   -> l'hôte ouvre une salle (son jeu fait tourner la partie)
//   /ws?room=1234&role=join   -> un joueur rejoint la salle
// Une salle = un Durable Object (relais): l'hôte envoie l'état du jeu à tous, les joueurs envoient leurs touchers à l'hôte.

const MAX_GUESTS = 3;   // 1 hôte + 3 joueurs
const enc = new TextEncoder();
const dec = new TextDecoder();
const txt = (m) => (typeof m === "string" ? m : dec.decode(m));

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/ws") {
      const room = (url.searchParams.get("room") || "").replace(/[^0-9]/g, "");
      if (room.length !== 4) return new Response("code de salle invalide", { status: 400 });
      if (req.headers.get("Upgrade") !== "websocket") return new Response("WebSocket attendu", { status: 426 });
      const stub = env.SALLES.get(env.SALLES.idFromName(room));
      return stub.fetch(req);
    }
    if (url.pathname === "/api/statut") return Response.json({ ok: true, jeu: "casse-croute-rush" }, { headers: { "Access-Control-Allow-Origin": "*" } });
    return env.ASSETS.fetch(req);
  },
};

export class Salle {
  constructor(state, env) {
    this.state = state;
    // "ping" -> "pong" sans réveiller l'objet (garde la connexion ouverte)
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  sockets(role) {
    return this.state.getWebSockets(role).filter((w) => w.readyState === 1 || w.readyState === undefined);   // 1 = OPEN
  }

  send(ws, obj) {
    try { ws.send(enc.encode(typeof obj === "string" ? obj : JSON.stringify(obj))); } catch (e) {}
  }

  async fetch(req) {
    const url = new URL(req.url);
    const role = url.searchParams.get("role") === "host" ? "host" : "join";
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    if (role === "host") {
      if (this.sockets("host").length > 0) {   // code déjà pris: le jeu en tire un autre
        this.state.acceptWebSocket(server, ["refus"]);
        this.send(server, { t: "err", m: "pris" });
        server.close(4001, "pris");
        return new Response(null, { status: 101, webSocket: client });
      }
      this.state.acceptWebSocket(server, ["host"]);
      server.serializeAttachment({ role: "host", slot: 0 });
      this.send(server, { t: "ok", slot: 0 });
      return new Response(null, { status: 101, webSocket: client });
    }

    // joueur
    const host = this.sockets("host")[0];
    const used = this.sockets("guest").map((w) => (w.deserializeAttachment() || {}).slot);
    let slot = 0;
    for (let s = 1; s <= MAX_GUESTS; s++) if (!used.includes(s)) { slot = s; break; }
    if (!host || slot === 0) {
      this.state.acceptWebSocket(server, ["refus"]);
      this.send(server, { t: "err", m: host ? "pleine" : "introuvable" });
      server.close(4002, host ? "pleine" : "introuvable");
      return new Response(null, { status: 101, webSocket: client });
    }
    this.state.acceptWebSocket(server, ["guest"]);
    server.serializeAttachment({ role: "guest", slot });
    this.send(server, { t: "ok", slot });
    this.send(host, { t: "join", slot });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws, msg) {
    const a = ws.deserializeAttachment() || {};
    const s = txt(msg);
    if (s === "ping") return;
    if (a.role === "host") {
      // état du jeu -> tous les joueurs
      for (const g of this.sockets("guest")) this.send(g, s);
    } else if (a.role === "guest") {
      // toucher d'un joueur -> l'hôte, avec son numéro
      const host = this.sockets("host")[0];
      if (host) this.send(host, '{"t":"from","slot":' + a.slot + ',"d":' + s + "}");
    }
  }

  async webSocketClose(ws) { this.left(ws); }
  async webSocketError(ws) { this.left(ws); }

  left(ws) {
    const a = ws.deserializeAttachment() || {};
    if (a.role === "host") {
      for (const g of this.sockets("guest")) { this.send(g, { t: "bye" }); try { g.close(4003, "hote parti"); } catch (e) {} }
    } else if (a.role === "guest") {
      const host = this.sockets("host")[0];
      if (host) this.send(host, { t: "leave", slot: a.slot });
    }
    try { ws.close(1000, "fin"); } catch (e) {}
  }
}
