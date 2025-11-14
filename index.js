// Render サーバーコード (v4: createRoom のバグ修正)
const WebSocket = require('ws');

const port = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: port, host: '0.0.0.0' });

const rooms = new Map();

function generateRoomId() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

wss.on('listening', () => {
    console.log(`WebSocketサーバーが ${port} 番ポートで起動しました。`);
});

// 相手プレイヤーを取得するヘルパー関数
function getOpponent(ws) {
    const room = rooms.get(ws.roomId);
    if (!room || room.players.length < 2) return null;
    return room.players.find(player => player !== ws);
}

wss.on('connection', (ws) => {
    console.log('クライアントが接続しました。');
    ws.isReadyForNextMatch = false; 

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch (e) { return; }
        
        const room = rooms.get(ws.roomId);

        switch (data.type) {
            case 'createRoom': {
                let roomId;
                do { roomId = generateRoomId(); } while (rooms.has(roomId));
                
                // ▼▼▼ 修正: クライアントから送られた設定を使う ▼▼▼
                const settings = data.settings || { limitMode: false, highlightOldest: false };
                
                const newRoom = {
                    players: [ws],
                    settings: settings, // <-- 適用
                };
                
                rooms.set(roomId, newRoom);
                ws.roomId = roomId;
                ws.isReadyForNextMatch = false;

                ws.send(JSON.stringify({ type: 'roomCreated', roomId: roomId }));
                console.log(`ルーム作成: ${roomId}`);
                break;
            }
            
            case 'updateSettings': {
                if (room && room.players[0] === ws) { // ホストのみ
                    room.settings = data.settings;
                    console.log(`ルーム ${ws.roomId} の設定が更新されました。`);
                }
                break;
            }

            case 'joinRoom': {
                const roomId = data.roomId.toUpperCase();
                const joinedRoom = rooms.get(roomId);

                if (!joinedRoom) {
                    ws.send(JSON.stringify({ type: 'error', message: 'ルームが見つかりません。' })); return;
                }
                if (joinedRoom.players.length >= 2) {
                    ws.send(JSON.stringify({ type: 'error', message: 'ルームは満員です。' })); return;
                }

                joinedRoom.players.push(ws);
                ws.roomId = roomId;
                ws.isReadyForNextMatch = false;

                console.log(`ルーム参加: ${roomId}`);

                const [host, guest] = joinedRoom.players;
                
                host.send(JSON.stringify({ type: 'gameStart', mark: 'O', settings: joinedRoom.settings }));
                guest.send(JSON.stringify({ type: 'gameStart', mark: 'X', settings: joinedRoom.settings }));
                break;
            }

            case 'move': {
                const opponent = getOpponent(ws);
                if (opponent) {
                    opponent.send(JSON.stringify({ type: 'opponentMove', cellIndex: data.cellIndex }));
                }
                break;
            }
            
            case 'offerDraw': {
                const opponent = getOpponent(ws);
                if (opponent) {
                    console.log(`ルーム ${ws.roomId} でDRAW提案`);
                    opponent.send(JSON.stringify({ type: 'surrenderOffered' }));
                }
                break;
            }
            
            case 'acceptDraw': {
                if (!room) break;
                console.log(`ルーム ${ws.roomId} でDRAW成立`);
                room.players.forEach(player => {
                    player.isReadyForNextMatch = false;
                    player.send(JSON.stringify({ type: 'gameDrawnByAgreement' }));
                });
                break;
            }
            
            case 'readyForNextMatch': {
                ws.isReadyForNextMatch = true;
                const opponent = getOpponent(ws);

                if (opponent && opponent.isReadyForNextMatch) {
                    console.log(`ルーム ${ws.roomId} で次の対戦が開始されます。`);
                    
                    const firstPlayer = 'O'; // TODO: 手番入れ替え
                    
                    room.players.forEach(player => {
                        player.isReadyForNextMatch = false;
                        player.send(JSON.stringify({ type: 'startNextMatch', firstPlayer: firstPlayer }));
                    });
                }
                break;
            }
        }
    });

    ws.on('close', () => {
        console.log('クライアントが切断しました。');
        const opponent = getOpponent(ws);
        if (opponent) {
            opponent.send(JSON.stringify({ type: 'opponentDisconnected' }));
        }
        const room = rooms.get(ws.roomId);
        if (room) {
            room.players = room.players.filter(p => p !== ws);
            if (room.players.length === 0) {
                rooms.delete(ws.roomId);
                console.log(`ルーム削除: ${ws.roomId}`);
            }
        }
    });
});
