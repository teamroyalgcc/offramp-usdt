
import { WebSocketServer, WebSocket } from 'ws';
import { Server } from 'http';
import jwt from 'jsonwebtoken';
import config from '../config/index.js';

interface AuthenticatedWebSocket extends WebSocket {
  userId?: string;
  isAlive: boolean;
}

export class WSService {
  private static instance: WSService;
  private wss: WebSocketServer | null = null;
  private clients: Map<string, Set<AuthenticatedWebSocket>> = new Map();

  private constructor() {}

  public static getInstance(): WSService {
    if (!WSService.instance) {
      WSService.instance = new WSService();
    }
    return WSService.instance;
  }

  public init(server: Server) {
    this.wss = new WebSocketServer({ server, path: '/ws' });

    this.wss.on('connection', (ws: AuthenticatedWebSocket, req) => {
      ws.isAlive = true;
      ws.on('pong', () => (ws.isAlive = true));

      // Simple auth via query param or header
      const url = new URL(req.url || '', `http://${req.headers.host}`);
      const token = url.searchParams.get('token');

      if (token) {
        try {
          const decoded = jwt.verify(token, config.jwtSecret) as any;
          ws.userId = decoded.id;
          
          if (!this.clients.has(ws.userId!)) {
            this.clients.set(ws.userId!, new Set());
          }
          this.clients.get(ws.userId!)?.add(ws);
          console.log(`[WS] Client connected for user: ${ws.userId}`);
        } catch (err) {
          console.error('[WS] Auth failed:', err);
          ws.close(4001, 'Unauthorized');
        }
      }

      ws.on('close', () => {
        if (ws.userId && this.clients.has(ws.userId)) {
          this.clients.get(ws.userId)?.delete(ws);
          if (this.clients.get(ws.userId)?.size === 0) {
            this.clients.delete(ws.userId);
          }
        }
        console.log(`[WS] Client disconnected: ${ws.userId}`);
      });
    });

    // Heartbeat
    setInterval(() => {
      this.wss?.clients.forEach((ws: any) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
      });
    }, 30000);
  }

  public sendToUser(userId: string, type: string, payload: any) {
    const userClients = this.clients.get(userId);
    if (userClients) {
      const message = JSON.stringify({ type, payload, timestamp: new Date().toISOString() });
      userClients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
          client.send(message);
        }
      });
    }
  }

  public broadcast(type: string, payload: any) {
    const message = JSON.stringify({ type, payload, timestamp: new Date().toISOString() });
    this.wss?.clients.forEach(client => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  }
}

export default WSService.getInstance();
