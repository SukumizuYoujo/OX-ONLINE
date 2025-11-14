// Render / Replit 兼用 サーバーコード
const WebSocket = require('ws');

// Renderは $PORT 環境変数を自動で設定します
const port = process.env.PORT || 8080;
// Renderは '0.0.0.0' での待機が必要です
const wss = new WebSocket.Server({ port: port, host: '0.0.0.0' });

const rooms = new Map();

function generateRoomId() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

wss.on('listening', () => {
    console.log(`WebSocketサーバーが ${port} 番ポートで起動しました。`);
});

wss.on('connection', (ws) => {
    console.log('クライアントが接続しました。');

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch (e) { return; }

        switch (data.type) {
            case 'createRoom': {
                let roomId;
                do {
                    roomId = generateRoomId();
                } while (rooms.has(roomId));

                const settings = data.settings || { limitMode: false, highlightOldest: false };
                rooms.set(roomId, { players: [ws], settings: settings });
                ws.roomId = roomId;

                ws.send(JSON.stringify({ type: 'roomCreated', roomId: roomId }));
                console.log(`ルーム作成: ${roomId}`);
                break;
            }
            case 'joinRoom': {
                const roomId = data.roomId.toUpperCase();
                const room = rooms.get(roomId);

                if (!room) {
                    ws.send(JSON.stringify({ type: 'error', message: 'ルームが見つかりません。' }));
                    return;
                }
                if (room.players.length >= 2) {
                    ws.send(JSON.stringify({ type: 'error', message: 'ルームは満員です。' }));
                    return;
                }

                room.players.push(ws);
                ws.roomId = roomId;
                console.log(`ルーム参加: ${roomId}`);

                const [host, guest] = room.players;
                host.send(JSON.stringify({ type: 'gameStart', mark: 'O', settings: room.settings }));
                guest.send(JSON.stringify({ type: 'gameStart', mark: 'X', settings: room.settings }));
                break;
            }
            case 'move': {
                const roomId = ws.roomId;
                const room = rooms.get(roomId);
                if (!room || room.players.length < 2) return; 
                const opponent = room.players.find(player => player !== ws);

                if (opponent && opponent.readyState === WebSocket.OPEN) {
                    opponent.send(JSON.stringify({ type: 'opponentMove', cellIndex: data.cellIndex }));
                }
                break;
            }
        }
    });

    ws.on('close', () => {
        console.log('クライアントが切断しました。');
        const roomId = ws.roomId;
        const room = rooms.get(roomId);

        if (room) {
            const opponent = room.players.find(player => player !== ws);
            if (opponent && opponent.readyState === WebSocket.OPEN) {
                opponent.send(JSON.stringify({ type: 'opponentDisconnected' }));
            }
            rooms.delete(roomId);
            console.log(`ルーム削除: ${roomId}`);
        }
    });
});
