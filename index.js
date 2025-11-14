// Render サーバーコード (v6: 盤面サイズ、先手/後手 対応)
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

// ヘルパー関数
function getOpponent(ws) {
    const room = rooms.get(ws.roomId);
    if (!room || room.players.length < 2) return null;
    return room.players.find(player => player !== ws);
}

function resetReadyStates(room) {
    room.players.forEach(player => {
        player.isReadyForMatch = false;
        player.isReadyForLobby = false;
    });
}

// ▼▼▼ 新規: デフォルト設定 ▼▼▼
const defaultSettings = {
    boardSize: 3,
    playerOrder: 'random',
    limitMode: false,
    highlightOldest: false
};

wss.on('connection', (ws) => {
    console.log('クライアントが接続しました。');
    ws.isReadyForMatch = false; 
    ws.isReadyForLobby = false;

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch (e) { return; }
        
        const room = rooms.get(ws.roomId);

        switch (data.type) {
            case 'createRoom': {
                let roomId;
                do { roomId = generateRoomId(); } while (rooms.has(roomId));
                
                // ▼▼▼ 変更: クライアントからの設定をマージ ▼▼▼
                const settings = { ...defaultSettings, ...(data.settings || {}) };
                
                const newRoom = {
                    players: [ws],
                    settings: settings,
                };
                
                rooms.set(roomId, newRoom);
                ws.roomId = roomId;

                ws.send(JSON.stringify({ type: 'roomCreated', roomId: roomId }));
                console.log(`ルーム作成: ${roomId}`);
                break;
            }
            
            case 'updateSettings': {
                if (room && room.players[0] === ws) { // ホストのみ
                    room.settings = { ...room.settings, ...(data.settings || {}) };
                    console.log(`ルーム ${ws.roomId} の設定が更新されました。`);
                    
                    const opponent = getOpponent(ws);
                    if (opponent) {
                        opponent.send(JSON.stringify({ type: 'settingsUpdated', settings: room.settings }));
                    }
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

                console.log(`ルーム参加: ${roomId}`);
                resetReadyStates(joinedRoom);

                const [host, guest] = joinedRoom.players;
                
                host.send(JSON.stringify({ type: 'gameStart', mark: 'O', settings: joinedRoom.settings, isHost: true }));
                guest.send(JSON.stringify({ type: 'gameStart', mark: 'X', settings: joinedRoom.settings, isHost: false }));
                break;
            }

            case 'move': {
                const opponent = getOpponent(ws);
                if (opponent) {
                    opponent.send(JSON.stringify({ type: 'opponentMove', cellIndex: data.cellIndex }));
                }
                break;
            }
            
            case 'offerSurrender': {
                const opponent = getOpponent(ws);
                if (opponent) {
                    opponent.send(JSON.stringify({ type: 'surrenderOffered' }));
                }
                break;
            }
            
            case 'acceptSurrender': {
                if (!room) break;
                const opponent = getOpponent(ws); // 提案した人(敗者)
                
                if (opponent) opponent.send(JSON.stringify({ type: 'gameLostBySurrender' }));
                ws.send(JSON.stringify({ type: 'gameWonBySurrender' })); // 受諾した人(勝者)
                
                resetReadyStates(room);
                break;
            }
            
            case 'readyForMatch': {
                if (!room) break;
                ws.isReadyForMatch = true;
                const opponent = getOpponent(ws);

                if (opponent && opponent.isReadyForMatch) {
                    console.log(`ルーム ${ws.roomId} で試合開始`);
                    resetReadyStates(room);
                    
                    // ▼▼▼ 新規: 先手/後手 ルール適用 ▼▼▼
                    let firstPlayer = 'O';
                    const order = room.settings.playerOrder;
                    if (order === 'host_o') {
                        firstPlayer = 'O';
                    } else if (order === 'host_x') {
                        firstPlayer = 'X';
                    } else { // random
                        firstPlayer = (Math.random() < 0.5 ? 'O' : 'X');
                    }
                    
                    room.players.forEach(player => {
                        player.send(JSON.stringify({ type: 'startMatch', firstPlayer: firstPlayer }));
                    });
                }
                break;
            }
            
            case 'readyForLobby': {
                if (!room) break;
                ws.isReadyForLobby = true;
                const opponent = getOpponent(ws);
                
                if (opponent && opponent.isReadyForLobby) {
                    console.log(`ルーム ${ws.roomId} でロビーに戻る`);
                    resetReadyStates(room);
                    
                    room.players.forEach(player => {
                        player.send(JSON.stringify({ type: 'returnToLobby' }));
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
