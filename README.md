# Turkey Chase 8 — multiplayer server

This is the one server that every copy of Turkey Chase 8 (website, Windows, Mac, Android) connects to
when someone presses **🌐 Play Server**. It runs the shared turkeys (first to catch one gets it),
the weather and the chat (with name checks and spam limits). It doesn't keep
anyone's progress.

It's a small Node.js app (Node 18 or newer). It needs to be reachable over **https** (so the game can
connect with `wss://`), because the website and the apps all run on secure pages.

## Easiest: Render (free)

1. Put this folder in a GitHub repository (just these files: `server.js`, `species.json`, `package.json`, `README.md`).
2. Go to <https://render.com>, sign in, and choose **New → Web Service**. Pick the repository.
3. Settings:
   - **Runtime:** Node
   - **Build command:** `npm install`
   - **Start command:** `npm start`
   - **Instance type:** Free
4. Press **Create Web Service**. When it says *Live*, open the address it gives you
   (like `https://your-name.onrender.com`). You should see *"Turkey Chase 8 server is running."*
5. Send that address to Claude, and every version of the game gets rebuilt to connect to it
   (as `wss://your-name.onrender.com`).

On Render's free plan the server goes to sleep after 15 minutes with nobody on it. The next
person to press Play Server waits up to about a minute while it wakes up (the game tells them).
A paid instance stays awake.

## Your own machine (e.g. an Azure VM)

```
npm install
PORT=8080 npm start
```

Keep it running with something like `pm2` or a systemd service, and put it behind HTTPS
(for example Caddy or nginx with a certificate), forwarding WebSocket traffic to the port.
The game then connects to `wss://your-domain`.

## Checking it

Open the server's address in a browser: it says how many players are online.
