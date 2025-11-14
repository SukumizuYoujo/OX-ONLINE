// Render サーバーコード (v8: 多人数ロビー, 観戦, チャット対応)
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

// === ヘルパー関数 ===

// ルームの全員にブロードキャスト
function broadcast(room, message, excludeWs = null) {
    if (!room) return;
    const stringMessage = JSON.stringify(message);
    room.players.forEach((playerInfo, ws) => {
        if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
            ws.send(stringMessage);
        }
    });
}

// ルームの対戦者2人だけに送信
function broadcastToPlayers(room, message) {
    if (!room) return;
    const stringMessage = JSON.stringify(message);
    if (room.playerO && room.playerO.readyState === WebSocket.OPEN) {
        room.playerO.send(stringMessage);
    }
    if (room.playerX && room.playerX.readyState === WebSocket.OPEN) {
        room.playerX.send(stringMessage);
    }
}

// ルームの現在の状態(ロビー情報)を取得
function getLobbyState(room) {
    const playerO_Info = room.playerO ? room.players.get(room.playerO) : null;
    const playerX_Info = room.playerX ? room.players.get(room.playerX) : null;
    
    const spectators = [];
    room.players.forEach((playerInfo, ws) => {
        if (ws !== room.playerO && ws !== room.playerX) {
            spectators.push(playerInfo);
        }
    });

    return {
        settings: room.settings,
        playerO: playerO_Info,
        playerX: playerX_Info,
        spectators: spectators
    };
}

// プレイヤーの準備状態をリセット
function resetReadyStates(room) {
    room.players.forEach(playerInfo => {
        playerInfo.isReadyForMatch = false;
        playerInfo.isReadyForLobby = false;
    });
}

const defaultSettings = {
    boardSize: 3,
    playerOrder: 'random',
    limitMode: false,
    highlightOldest: false
};

// === 接続処理 ===

wss.on('connection', (ws) => {
    console.log('クライアントが接続しました。');

    // 接続時にwsにカスタムプロパティを初期化
    ws.roomId = null;

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch (e) { return; }
        
        const room = rooms.get(ws.roomId);

        switch (data.type) {
            case 'createRoom': {
                let roomId;
                do { roomId = generateRoomId(); } while (rooms.has(roomId));
                
                const settings = { ...defaultSettings, ...(data.settings || {}) };
                const username = data.username || `User${Math.floor(Math.random() * 1000)}`;
                
                const newRoom = {
                    settings: settings,
                    players: new Map(), // ws -> { username }
                    playerO: null,
                    playerX: null,
                    gameState: 'LOBBY',
                };
                
                newRoom.players.set(ws, { username: username });
                rooms.set(roomId, newRoom);
                ws.roomId = roomId;

                ws.send(JSON.stringify({ 
                    type: 'roomJoined', 
                    isHost: true,
                    mark: 'SPECTATOR', // 初期は観戦者
                    lobby: getLobbyState(newRoom)
                }));
                console.log(`[${roomId}] ${username} がルームを作成しました。`);
                break;
            }
            
            case 'joinRoom': {
                const roomId = data.roomId.toUpperCase();
                const username = data.username || `User${Math.floor(Math.random() * 1000)}`;
                const joinedRoom = rooms.get(roomId);

                if (!joinedRoom) {
                    ws.send(JSON.stringify({ type: 'error', message: 'ルームが見つかりません。' })); return;
                }
                
                // 接続をルームに追加
                joinedRoom.players.set(ws, { username: username });
                ws.roomId = roomId;

                // 参加した本人に通知
                ws.send(JSON.stringify({ 
                    type: 'roomJoined', 
                    isHost: false,
                    mark: 'SPECTATOR',
                    lobby: getLobbyState(joinedRoom)
                }));
                
                // 他の全員にロビー更新とチャット通知を送信
                broadcast(joinedRoom, { 
                    type: 'lobbyUpdate', 
                    lobby: getLobbyState(joinedRoom) 
                }, ws);
                broadcast(joinedRoom, {
                    type: 'newChat',
                    message: `${username} が入室しました。`,
                    isNotification: true
                }, ws);
                
                console.log(`[${roomId}] ${username} がルームに参加しました。`);
                break;
            }

            case 'updateSettings': {
                if (room && room.players.get(ws) && room.players.keys().next().value === ws) { // ホストのみ
                    room.settings = { ...room.settings, ...(data.settings || {}) };
                    console.log(`[${ws.roomId}] 設定が更新されました。`);
                    
                    broadcast(room, { 
                        type: 'settingsUpdated', 
                        settings: room.settings 
                    });
                }
                break;
            }
            
            // ▼▼▼ 新規: スロット参加 ▼▼▼
            case 'takeSlot': {
                if (!room || room.gameState !== 'LOBBY') return;
                const playerInfo = room.players.get(ws);
                if (!playerInfo) return;

                if (data.slot === 'O' && !room.playerO) {
                    room.playerO = ws;
                    ws.send(JSON.stringify({ type: 'youTookSlot', slot: 'O', lobby: getLobbyState(room) }));
                    broadcast(room, { type: 'lobbyUpdate', lobby: getLobbyState(room) }, ws);
                    console.log(`[${ws.roomId}] ${playerInfo.username} が O に着席`);
                } else if (data.slot === 'X' && !room.playerX) {
                    room.playerX = ws;
                    ws.send(JSON.stringify({ type: 'youTookSlot', slot: 'X', lobby: getLobbyState(room) }));
                    broadcast(room, { type: 'lobbyUpdate', lobby: getLobbyState(room) }, ws);
                    console.log(`[${ws.roomId}] ${playerInfo.username} が X に着席`);
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'スロットは既に埋まっています。' }));
                }
                break;
            }
            
            // ▼▼▼ 新規: スロット退出 ▼▼▼
            case 'leaveSlot': {
                if (!room) return;
                const playerInfo = room.players.get(ws);
                if (!playerInfo) return;

                if (data.slot === 'O' && room.playerO === ws) {
                    room.playerO = null;
                    ws.send(JSON.stringify({ type: 'youLeftSlot', lobby: getLobbyState(room) }));
                    broadcast(room, { type: 'lobbyUpdate', lobby: getLobbyState(room) }, ws);
                    console.log(`[${ws.roomId}] ${playerInfo.username} が O から離席`);
                } else if (data.slot === 'X' && room.playerX === ws) {
                    room.playerX = null;
                    ws.send(JSON.stringify({ type: 'youLeftSlot', lobby: getLobbyState(room) }));
                    broadcast(room, { type: 'lobbyUpdate', lobby: getLobbyState(room) }, ws);
                    console.log(`[${ws.roomId}] ${playerInfo.username} が X から離席`);
                }
                break;
            }
            
            // ▼▼▼ 新規: チャット ▼▼▼
            case 'chat': {
                if (!room) return;
                const playerInfo = room.players.get(ws);
                if (playerInfo && data.message) {
                    broadcast(room, {
                        type: 'newChat',
                        from: playerInfo.username,
                        message: data.message
                    }, ws); // 送信者以外にブロードキャスト
                }
                break;
            }

            case 'readyForMatch': {
                if (!room || !room.playerO || !room.playerX) return; // 両方埋まってないとダメ
                const playerInfo = room.players.get(ws);
                if (!playerInfo) return;
                
                playerInfo.isReadyForMatch = true;
                
                const opponent = (ws === room.playerO) ? room.playerX : room.playerO;
                const opponentInfo = opponent ? room.players.get(opponent) : null;

                if (opponentInfo && opponentInfo.isReadyForMatch) {
                    console.log(`[${ws.roomId}] 試合開始`);
                    room.gameState = 'IN_GAME';
                    resetReadyStates(room);
                    
                    const order = room.settings.playerOrder;
                    const hostMark = (order === 'host_x') ? 'X' : 'O'; // ホストが希望したマーク
                    
                    let oPlayer = room.players.keys().next().value; // デフォルトでホストがO
                    let xPlayer = null;
                    
                    room.players.forEach((p, w) => {
                        if (w !== oPlayer) xPlayer = w; // 暫定
                    });
                    
                    const hostWs = room.players.keys().next().value;
                    const guestWs = Array.from(room.players.keys())[1] || null; // 2人目 (ゲストとは限らない)
                    
                    // 実際に対戦する2人
                    oPlayer = room.playerO;
                    xPlayer = room.playerX;
                    
                    let firstPlayer = 'O'; // 先手はO

                    // サーバー側でO/Xの割り当てを決定
                    if (order === 'host_o') { // ホストがO希望
                        if (hostWs === oPlayer) { oPlayer = hostWs; xPlayer = guestWs; }
                        else { oPlayer = hostWs; xPlayer = guestWs; } // ホストがOスロットにいる
                    } else if (order === 'host_x') { // ホストがX希望
                        if (hostWs === xPlayer) { oPlayer = guestWs; xPlayer = hostWs; }
                        else { oPlayer = guestWs; xPlayer = hostWs; } // ホストがXスロットにいる
                    } else if (order === 'random') {
                        if (Math.random() < 0.5) {
                            // oPlayer, xPlayer はスロット通り
                        } else {
                            // O/X入れ替え
                            [oPlayer, xPlayer] = [xPlayer, oPlayer];
                        }
                    }
                    
                    // 最終的なマークを格納 (重要)
                    room.players.get(oPlayer).mark = 'O';
                    room.players.get(xPlayer).mark = 'X';
                    
                    // 観戦者にもマークを伝える
                    room.players.forEach((p, w) => {
                       if (w !== oPlayer && w !== xPlayer) p.mark = 'SPECTATOR';
                    });
                    
                    // 全員に試合開始を通知
                    broadcast(room, { type: 'matchStarting', firstPlayer: 'O' });
                }
                break;
            }
            
            case 'move': {
                if (!room || room.gameState !== 'IN_GAME') return;
                const playerInfo = room.players.get(ws);
                if (!playerInfo) return;
                
                const playerMark = (ws === room.playerO) ? 'O' : 'X';
                
                broadcast(room, { 
                    type: 'boardUpdate', 
                    cellIndex: data.cellIndex,
                    player: playerMark // O or X
                });
                break;
            }
            
            case 'gameOver': { // クライアントからの勝敗申告
                if (!room || room.gameState !== 'IN_GAME') return;
                room.gameState = 'POST_GAME';
                console.log(`[${ws.roomId}] 試合終了: ${data.result}`);
                broadcast(room, { type: 'gameOver', result: data.result });
                resetReadyStates(room);
                break;
            }
            
            case 'offerDraw': {
                const opponent = (ws === room.playerO) ? room.playerX : room.playerO;
                if (opponent) {
                    opponent.send(JSON.stringify({ type: 'drawOffered' }));
                }
                break;
            }
            
            case 'acceptDraw': {
                if (!room) break;
                console.log(`[${ws.roomId}] 合意DRAW成立`);
                room.gameState = 'POST_GAME';
                broadcast(room, { type: 'gameDrawnByAgreement' });
                resetReadyStates(room);
                break;
            }
            
            case 'readyForLobby': {
                if (!room || room.gameState !== 'POST_GAME') return;
                const playerInfo = room.players.get(ws);
                if (!playerInfo) return;

                playerInfo.isReadyForLobby = true;
                
                // 対戦者と観戦者全員の準備OKを待つ
                let allReady = true;
                room.players.forEach(p => {
                    if (!p.isReadyForLobby) allReady = false;
                });

                if (allReady) {
                    console.log(`[${ws.roomId}] 全員ロビーに戻る`);
                    room.gameState = 'LOBBY';
                    room.playerO = null;
                    room.playerX = null;
                    resetReadyStates(room);
                    
                    broadcast(room, { 
                        type: 'returnToLobby',
                        lobby: getLobbyState(room)
                    });
                }
                break;
            }
        }
    });

    ws.on('close', () => {
        console.log('クライアントが切断しました。');
        const room = rooms.get(ws.roomId);
        if (room) {
            const playerInfo = room.players.get(ws);
            const username = playerInfo ? playerInfo.username : '不明なユーザー';
            
            // プレイヤーリストから削除
            room.players.delete(ws);
            
            // スロットにいたら空ける
            let wasPlayer = false;
            if (room.playerO === ws) {
                room.playerO = null;
                wasPlayer = true;
            }
            if (room.playerX === ws) {
                room.playerX = null;
                wasPlayer = true;
            }
            
            if (room.players.size === 0) {
                // 最後の1人ならルーム削除
                rooms.delete(ws.roomId);
                console.log(`[${ws.roomId}] 最後のユーザーが退出。ルーム削除。`);
            } else {
                // 他の人に通知
                if (room.gameState === 'IN_GAME' && wasPlayer) {
                    // 試合中の対戦相手が切断
                    room.gameState = 'LOBBY'; // 強制的にロビーに戻す
                    room.playerO = null;
                    room.playerX = null;
                    broadcast(room, {
                        type: 'opponentDisconnected',
                        lobby: getLobbyState(room)
                    });
                } else {
                    // それ以外の退出 (ロビー、観戦者など)
                    broadcast(room, { 
                        type: 'lobbyUpdate', 
                        lobby: getLobbyState(room)
                    });
                }
                broadcast(room, {
                    type: 'newChat',
                    message: `${username} が退出しました。`,
                    isNotification: true
                });
            }
        }
    });
});
