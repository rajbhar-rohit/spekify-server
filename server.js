const http = require('http');
const WebSocket = require('ws');

const activeSessions = {};

const server = http.createServer((req, res) => {
    // 1. CORS & Safety Headers (Prevents Android from blocking the request)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Content-Type', 'application/json');

    // Instantly approve OPTIONS preflight requests
    if (req.method === 'OPTIONS') {
        res.writeHead(200);
        res.end();
        return;
    }

    console.log(`\n[INCOMING REQUEST] ${req.method} ${req.url}`);

        // 2. Health Check (Accepts both browser GETs and Robot HEADs)
    if ((req.method === 'GET' || req.method === 'HEAD') && req.url === '/') {
        res.writeHead(200);
        res.end(JSON.stringify({ status: "Spekify Server is awake and ready!" }));
        return;
    }
    

    let body = '';
    req.on('data', chunk => body += chunk.toString());
    req.on('end', () => {
        let parsedBody = {};
        if (body) {
            try { parsedBody = JSON.parse(body); } catch (e) { console.log("Failed to parse JSON body"); }
        }

        // 3. GUEST ROUTE
        if (req.method === 'POST' && req.url === '/v1/together/sessions/resolve') {
            const requestedCode = parsedBody.code;
            const sessionCodeKey = Object.keys(activeSessions).find(k => activeSessions[k].code === requestedCode);
            const session = activeSessions[sessionCodeKey];

            if (session) {
                console.log(`[SUCCESS] Guest joined session ${requestedCode}`);
                res.writeHead(200);
                res.end(JSON.stringify({
                    sessionId: session.sessionId,
                    guestKey: session.guestKey,
                    wsUrl: session.wsUrl,
                    settings: session.settings
                }));
            } else {
                console.log(`[FAILED] Guest tried to join invalid code: ${requestedCode}`);
                res.writeHead(404);
                res.end(JSON.stringify({ error: "Session not found" }));
            }
            return;
        }

        // 4. HOST ROUTE
        if (req.method === 'POST' && req.url === '/v1/together/sessions') {
            const randomCode = Math.floor(100000 + Math.random() * 900000).toString();
            
            // Generate the secure wss:// URL based on Render's host headers
            const secureWsUrl = "wss://" + req.headers.host + "/v1/together/ws";

            activeSessions[randomCode] = {
                sessionId: "sess-" + randomCode,
                code: randomCode,
                hostKey: "host-key-" + Date.now(),
                guestKey: "guest-key-" + Date.now(),
                wsUrl: secureWsUrl,
                settings: parsedBody.settings || { allowGuestsToAddTracks: true, allowGuestsToControlPlayback: false, requireHostApprovalToJoin: false },
                clients: new Set(),
                currentState: {
                    sessionId: "sess-" + randomCode,
                    hostId: "host-" + Date.now(),
                    participants: [],
                    settings: parsedBody.settings || {},
                    queue: [],
                    queueHash: "",
                    currentIndex: 0,
                    isPlaying: false,
                    positionMs: 0,
                    repeatMode: 0,
                    shuffleEnabled: false,
                    sentAtElapsedRealtimeMs: 0
                }
            };

            console.log(`[SUCCESS] Host created room with code: ${randomCode}`);
            res.writeHead(200);
            res.end(JSON.stringify({
                sessionId: activeSessions[randomCode].sessionId,
                code: activeSessions[randomCode].code,
                hostKey: activeSessions[randomCode].hostKey,
                guestKey: activeSessions[randomCode].guestKey,
                wsUrl: activeSessions[randomCode].wsUrl,
                settings: activeSessions[randomCode].settings
            }));
            return;
        }

        // 5. CATCH-ALL (If the app requests a weird URL, it won't timeout anymore!)
        console.log(`[WARNING] Route not found: ${req.url}`);
        res.writeHead(404);
        res.end(JSON.stringify({ error: "Route not found" }));
    });
});

// WEBSOCKET SERVER
const wss = new WebSocket.Server({ server, path: '/v1/together/ws' });

wss.on('connection', function connection(ws, req) {
    let assignedRoom = null;

    ws.on('message', function incoming(message) {
        const parsedMessage = JSON.parse(message.toString());

        // The Handshake
        if (parsedMessage.type === "client_hello") {
            const roomCode = Object.keys(activeSessions).find(code => activeSessions[code].sessionId === parsedMessage.sessionId);
            assignedRoom = activeSessions[roomCode];

            if (!assignedRoom) {
                ws.close();
                return;
            }

            assignedRoom.clients.add(ws);
            console.log(`[WEBSOCKET] User joined room ${roomCode}!`);

            ws.send(JSON.stringify({
                type: "server_welcome",
                protocolVersion: 1,
                sessionId: assignedRoom.sessionId,
                participantId: parsedMessage.clientId,
                role: "GUEST", 
                isPending: false,
                settings: assignedRoom.settings
            }));

            ws.send(JSON.stringify({
                type: "room_state",
                state: assignedRoom.currentState 
            }));
            return; 
        }

        // Broadcast music controls
        if (assignedRoom) {
            assignedRoom.clients.forEach(function each(client) {
                if (client !== ws && client.readyState === WebSocket.OPEN) {
                    client.send(message.toString());
                }
            });
        }
    });

    ws.on('close', () => {
        if (assignedRoom) {
            assignedRoom.clients.delete(ws);
            console.log(`[WEBSOCKET] A user disconnected.`);
        }
    });
});

const port = process.env.PORT || 8080;
server.listen(port, "0.0.0.0", () => {
  console.log(`Spekify Backend listening on port ${port}`);
});

