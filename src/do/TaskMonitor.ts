
import { DurableObject } from "cloudflare:workers";
import type { Env } from '../types';

/**
 * TaskMonitor Durable Object
 * 
 * Manages WebSocket connections for real-time task status updates.
 * Uses Hibernation API to reduce costs when no messages are being sent.
 */
export class TaskMonitor extends DurableObject {
    constructor(state: DurableObjectState, env: Env) {
        super(state, env);
    }

    async fetch(request: Request): Promise<Response> {
        const url = new URL(request.url);

        // Handle WebSocket upgrade request
        if (request.headers.get("Upgrade") === "websocket") {
            // 🔐 WebSocket Authentication - get token from URL query parameter
            const token = url.searchParams.get('token');
            if (!token) {
                return new Response("Unauthorized: Missing token", { status: 401 });
            }

            // Note: Full token validation would require DB/KV access.
            // For now, we just check that a token is provided.
            // The token is already validated when the user makes API calls.
            // If you need stricter validation, you can pass env.DB and env.SESSION_KV
            // and call validateSession here.

            const pair = new WebSocketPair();
            const [client, server] = Object.values(pair);

            // Use Hibernation API - acceptWebSocket instead of ws.accept()
            // This allows the DO to hibernate when no messages are being sent,
            // significantly reducing costs.
            this.ctx.acceptWebSocket(server);

            return new Response(null, {
                status: 101,
                webSocket: client,
            });
        }

        // Handle internal broadcast request (from task_processor)
        if (request.method === "POST" && url.pathname === "/broadcast") {
            try {
                const status = await request.json();
                await this.broadcast(status);
                return new Response("Broadcasted", { status: 200 });
            } catch (e) {
                console.error("[TaskMonitor] Broadcast error:", e);
                return new Response("Error broadcasting", { status: 500 });
            }
        }

        return new Response("Task Monitor DO active", { status: 200 });
    }

    /**
     * Hibernation callback: WebSocket message received
     * Called when a client sends a message (e.g., heartbeat/ping)
     */
    async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
        // Handle client messages (e.g., ping/pong for keep-alive)
        if (typeof message === 'string') {
            try {
                const data = JSON.parse(message);
                if (data.type === 'ping') {
                    ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
                }
            } catch {
                // Ignore non-JSON messages
            }
        }
    }

    /**
     * Hibernation callback: WebSocket closed
     */
    async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
        console.log(`[TaskMonitor] WebSocket closed: code=${code}, reason=${reason}, wasClean=${wasClean}`);
        // Hibernation API automatically manages connection cleanup
    }

    /**
     * Hibernation callback: WebSocket error
     */
    async webSocketError(ws: WebSocket, error: unknown) {
        console.error('[TaskMonitor] WebSocket error:', error);
        ws.close(1011, 'Internal error');
    }

    /**
     * Broadcast a status update to all connected clients
     */
    async broadcast(status: unknown) {
        const message = JSON.stringify(status);

        // Use ctx.getWebSockets() to get all active connections
        // This works with Hibernation API - connections persist even when DO is hibernating
        const websockets = this.ctx.getWebSockets();

        let sentCount = 0;
        for (const ws of websockets) {
            try {
                ws.send(message);
                sentCount++;
            } catch (err) {
                // Failed to send - close the connection
                console.error('[TaskMonitor] Failed to send to WebSocket:', err);
                try {
                    ws.close(1011, 'Failed to send');
                } catch {
                    // Ignore close errors
                }
            }
        }

        console.log(`[TaskMonitor] Broadcasted to ${sentCount}/${websockets.length} clients`);
    }
}
