// Render サーバーコード (v7: 投了 -> 無効試合DRAW に変更)
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
            
            // ▼▼▼ 変更: 「無効試合 投票」 ▼▼▼
            case 'offerDraw': {
                const opponent = getOpponent(ws);
                if (opponent) {
                    console.log(`ルーム ${ws.roomId} でDRAW提案`);
                    opponent.send(JSON.stringify({ type: 'drawOffered' }));
                }
                break;
            }
            
            // ▼▼▼ 変更: 「無効試合 受諾」 ▼▼▼
            case 'acceptDraw': {
                if (!room) break;
                console.log(`ルーム ${ws.roomId} でDRAW成立`);
                
                // 両方のプレイヤーにDRAWを通知
                room.players.forEach(player => {
                    player.send(JSON.stringify({ type: 'gameDrawnByAgreement' }));
                });
                
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
                    
                    let firstPlayer = 'O';
                    const order = room.settings.playerOrder;
                    const hostMark = (order === 'host_x') ? 'X' : 'O'; // ホストがOかXか
                    
                    if (order === 'random') {
                        firstPlayer = (Math.random() < 0.5 ? 'O' : 'X');
                    } else {
                        // ホストがO希望なら先手はO、ホストがX希望なら先手はX
                        firstPlayer = hostMark;
                    }
                    
                    // サーバー側はO/Xで管理し、クライアント側は firstPlayer で管理
                    room.players.forEach(player => {
                        const playerMark = (player === room.players[0]) ? hostMark : (hostMark === 'O' ? 'X' : 'O');
                        
                        // O/Xの割り当ては変えないが、手番だけを firstPlayer に合わせる
                        // (クライアント側は自分のマークと firstPlayer を比較して手番を判断する)
                        // ...と思ったが、クライアント側はOが先手と仮定してしまっている。
                        // サーバー側でO/Xの割り当て自体を変更する
                    }
                    
                    // --- 先手/後手ロジックの修正 ---
                    const host = room.players[0];
                    const guest = room.players[1];
                    let oPlayer = host;
                    let xPlayer = guest;
                    
                    if (order === 'host_o') {
                        oPlayer = host; xPlayer = guest; firstPlayer = 'O';
                    } else if (order === 'host_x') {
                        oPlayer = guest; xPlayer = host; firstPlayer = 'O'; // Xがホスト=ゲストがO (先手)
                    } else if (order === 'random') {
                        if (Math.random() < 0.5) { // ホストがO
                            oPlayer = host; xPlayer = guest; firstPlayer = 'O';
                        } else { // ゲストがO
                            oPlayer = guest; xPlayer = host; firstPlayer = 'O';
                        }
                    }
                    
                    // ※現状の実装では、クライアント(v6)はOが先手(firstPlayer)であると仮定している
                    // そのため、O/Xの割り当てを変更し、firstPlayerは常に'O'を渡す
                    
                    oPlayer.send(JSON.stringify({ type: 'startMatch', firstPlayer: 'O' }));
                    xPlayer.send(JSON.stringify({ type: 'startMatch', firstPlayer: 'O' }));
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
