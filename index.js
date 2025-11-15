// Render サーバーコード (v8.4: 降参・ロビー即時帰還 対応)
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

function broadcast(room, message, excludeWs = null) {
    if (!room) return;
    const stringMessage = JSON.stringify(message);
    room.players.forEach((playerInfo, ws) => {
        if (ws !== excludeWs && ws.readyState === WebSocket.OPEN) {
            ws.send(stringMessage);
        }
    });
}

function getLobbyState(room) {
    const playerO_Info = room.playerO ? room.players.get(room.playerO) : null;
    const playerX_Info = room.playerX ? room.players.get(room.playerX) : null;
    
    const spectators = [];
    room.players.forEach((playerInfo, ws) => {
        if (ws !== room.playerO && ws !== room.playerX) {
            spectators.push(playerInfo);
        }
    });
    
    const hostInfo = room.host ? room.players.get(room.host) : null;

    return {
        settings: room.settings,
        playerO: playerO_Info,
        playerX: playerX_Info,
        spectators: spectators,
        hostUsername: hostInfo ? hostInfo.username : ''
    };
}

function resetReadyStates(room) {
    room.players.forEach(playerInfo => {
        playerInfo.isReadyForMatch = false;
        // playerInfo.isReadyForLobby = false; // 廃止
    });
}

const defaultSettings = {
    boardSize: 3,
    playerOrder: 'random',
    limitMode: false,
    highlightOldest: false,
    isPublic: true, 
    maxPlayers: 10
};

// === 接続処理 ===

wss.on('connection', (ws) => {
    console.log('クライアントが接続しました。');
    ws.roomId = null;

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch (e) { console.error('Invalid JSON:', e); return; }
        
        const room = rooms.get(ws.roomId);
        const playerInfo = room ? room.players.get(ws) : null;

        switch (data.type) {
            case 'createRoom': {
                let roomId;
                do { roomId = generateRoomId(); } while (rooms.has(roomId));
                
                const settings = { ...defaultSettings, ...(data.settings || {}) };
                settings.maxPlayers = Math.max(2, Math.min(100, settings.maxPlayers || 10));
                
                const username = data.username || `User${Math.floor(Math.random() * 1000)}`;
                
                const newRoom = {
                    id: roomId, 
                    settings: settings,
                    players: new Map(),
                    playerO: null,
                    playerX: null,
                    gameState: 'LOBBY',
                    host: ws,
                    isPublic: settings.isPublic, 
                    maxPlayers: settings.maxPlayers 
                };
                
                newRoom.players.set(ws, { username: username, mark: 'SPECTATOR' });
                rooms.set(roomId, newRoom);
                ws.roomId = roomId;

                ws.send(JSON.stringify({ 
                    type: 'roomJoined', 
                    isHost: true,
                    mark: 'SPECTATOR',
                    lobby: getLobbyState(newRoom),
                    roomId: roomId
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
                
                if (joinedRoom.players.size >= joinedRoom.maxPlayers) {
                    ws.send(JSON.stringify({ type: 'error', message: 'ルームは満員です。' })); return;
                }
                
                joinedRoom.players.set(ws, { username: username, mark: 'SPECTATOR' });
                ws.roomId = roomId;

                ws.send(JSON.stringify({ 
                    type: 'roomJoined', 
                    isHost: (joinedRoom.host === ws),
                    mark: 'SPECTATOR',
                    lobby: getLobbyState(joinedRoom),
                    roomId: roomId
                }));
                
                broadcast(joinedRoom, { type: 'lobbyUpdate', lobby: getLobbyState(joinedRoom) }, ws);
                broadcast(joinedRoom, {
                    type: 'newChat',
                    from: 'システム',
                    message: `${username} が入室しました。`,
                    isNotification: true
                }, ws);
                
                console.log(`[${roomId}] ${username} がルームに参加しました。`);
                break;
            }

            case 'updateSettings': {
                if (room && room.host === ws) {
                    room.settings = { ...room.settings, ...(data.settings || {}) };
                    room.settings.maxPlayers = Math.max(2, Math.min(100, room.settings.maxPlayers || 10));
                    room.maxPlayers = room.settings.maxPlayers;
                    
                    console.log(`[${ws.roomId}] 設定が更新されました。`);
                    
                    broadcast(room, { 
                        type: 'settingsUpdated', 
                        settings: room.settings 
                    }, ws);
                }
                break;
            }

            case 'getRoomList': {
                const publicRooms = [];
                rooms.forEach((room, id) => {
                    if (room.isPublic && room.players.size < room.maxPlayers) {
                        publicRooms.push({
                            id: room.id,
                            count: room.players.size,
                            max: room.maxPlayers,
                            inGame: room.gameState !== 'LOBBY'
                        });
                    }
                });

                const page = data.page || 1;
                const limit = 5;
                const totalPages = Math.ceil(publicRooms.length / limit) || 1;
                const startIndex = (page - 1) * limit;
                const paginatedRooms = publicRooms.slice(startIndex, startIndex + limit);

                ws.send(JSON.stringify({
                    type: 'roomListUpdate',
                    rooms: paginatedRooms,
                    page: page,
                    totalPages: totalPages
                }));
                break;
            }
            
            case 'takeSlot': {
                if (!room || room.gameState !== 'LOBBY' || !playerInfo) return;
                if (room.playerO === ws || room.playerX === ws) return;

                if (data.slot === 'O' && !room.playerO) {
                    room.playerO = ws;
                    playerInfo.mark = 'O';
                } else if (data.slot === 'X' && !room.playerX) {
                    room.playerX = ws;
                    playerInfo.mark = 'X';
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'スロットは既に埋まっています。' }));
                    return;
                }
                
                ws.send(JSON.stringify({ type: 'youTookSlot', slot: data.slot, lobby: getLobbyState(room) }));
                broadcast(room, { type: 'lobbyUpdate', lobby: getLobbyState(room) }, ws);
                break;
            }
            
            case 'leaveSlot': {
                if (!room || !playerInfo) return;

                if (room.playerO === ws) {
                    room.playerO = null;
                } else if (room.playerX === ws) {
                    room.playerX = null;
                } else {
                    return;
                }
                
                playerInfo.mark = 'SPECTATOR';
                ws.send(JSON.stringify({ type: 'youLeftSlot', lobby: getLobbyState(room) }));
                broadcast(room, { type: 'lobbyUpdate', lobby: getLobbyState(room) }, ws);
                break;
            }
            
            case 'chat': {
                if (room && playerInfo && data.message) {
                    broadcast(room, {
                        type: 'newChat',
                        from: playerInfo.username,
                        message: data.message
                    }, ws);
                }
                break;
            }

            case 'readyForMatch': {
                if (!room || !playerInfo || !room.playerO || !room.playerX) return;
                
                playerInfo.isReadyForMatch = true;
                
                const opponent = (ws === room.playerO) ? room.playerX : room.playerO;
                const opponentInfo = opponent ? room.players.get(opponent) : null;

                if (opponentInfo && opponentInfo.isReadyForMatch) {
                    console.log(`[${ws.roomId}] 試合開始`);
                    room.gameState = 'IN_GAME';
                    resetReadyStates(room);
                    
                    const order = room.settings.playerOrder;
                    const hostWs = room.host;
                    
                    let oPlayer = room.playerO;
                    let xPlayer = room.playerX;
                    
                    if (order === 'host_o' && hostWs === room.playerX) {
                        [oPlayer, xPlayer] = [xPlayer, oPlayer];
                    } else if (order === 'host_x' && hostWs === room.playerO) {
                        [oPlayer, xPlayer] = [xPlayer, oPlayer];
                    } else if (order === 'random' && Math.random() < 0.5) {
                        [oPlayer, xPlayer] = [xPlayer, oPlayer];
                    }
                    
                    room.playerO = oPlayer;
                    room.playerX = xPlayer;
                    
                    room.players.forEach((p, w) => {
                        let mark = 'SPECTATOR';
                        if (w === oPlayer) mark = 'O';
                        else if (w === xPlayer) mark = 'X';
                        p.mark = mark;
                        
                        w.send(JSON.stringify({ 
                            type: 'matchStarting', 
                            firstPlayer: 'O',
                            myMark: mark
                        }));
                    });
                }
                break;
            }
            
            case 'move': {
                if (!room || room.gameState !== 'IN_GAME' || !playerInfo) return;
                
                const expectedMark = (ws === room.playerO) ? 'O' : 'X';
                
                broadcast(room, { 
                    type: 'boardUpdate', 
                    cellIndex: data.cellIndex,
                    player: expectedMark
                });
                break;
            }
            
            case 'gameOver': {
                if (!room || room.gameState !== 'IN_GAME') return;
                room.gameState = 'POST_GAME';
                console.log(`[${ws.roomId}] 試合終了: ${data.result}`);
                broadcast(room, { type: 'gameOver', result: data.result });
                resetReadyStates(room);
                break;
            }
            
            // ▼▼▼ 修正: 「降参」機能 ▼▼▼
            case 'surrender': {
                if (!room || room.gameState !== 'IN_GAME' || !playerInfo) return;

                let winnerMark = 'DRAW';
                if (ws === room.playerO) {
                    winnerMark = 'X'; // Oが降参したのでXの勝ち
                } else if (ws === room.playerX) {
                    winnerMark = 'O'; // Xが降参したのでOの勝ち
                }

                if (winnerMark !== 'DRAW') {
                    room.gameState = 'POST_GAME';
                    console.log(`[${ws.roomId}] ${playerInfo.username} が降参。${winnerMark} の勝利。`);
                    broadcast(room, { type: 'gameOver', result: winnerMark });
                    resetReadyStates(room);
                }
                break;
            }
            
            // ▼▼▼ 修正: 削除 (不要になったため) ▼▼▼
            // case 'offerDraw':
            // case 'acceptDraw': 
            
            // ▼▼▼ 修正: 「ロビーに戻る」機能 ▼▼▼
            case 'returnToLobby': {
                if (!room || !playerInfo) return; 
                
                // プレイヤーだった場合はスロットから抜ける
                if (ws === room.playerO) {
                    room.playerO = null;
                }
                if (ws === room.playerX) {
                    room.playerX = null;
                }
                playerInfo.mark = 'SPECTATOR';

                // 試合後の両者がロビーに戻ったら、部屋のステータスをロビーに戻す
                if (room.gameState === 'POST_GAME' && !room.playerO && !room.playerX) {
                    room.gameState = 'LOBBY';
                    console.log(`[${ws.roomId}] 両者がロビーに戻りました。`);
                }

                // 送信者自身に最新のロビー状態を送る
                ws.send(JSON.stringify({ 
                    type: 'lobbyUpdate',
                    lobby: getLobbyState(room)
                }));
                // 他の全員にも最新のロビー状態をブロードキャスト
                broadcast(room, { 
                    type: 'lobbyUpdate',
                    lobby: getLobbyState(room)
                }, ws);
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
            
            room.players.delete(ws);
            
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
                rooms.delete(ws.roomId);
                console.log(`[${ws.roomId}] 最後のユーザーが退出。ルーム削除。`);
            } else {
                let newHostUsername = null;
                if (room.host === ws) {
                    room.host = room.players.keys().next().value;
                    const newHostInfo = room.players.get(room.host);
                    newHostUsername = newHostInfo.username;
                    console.log(`[${ws.roomId}] ホストが ${newHostUsername} に移譲されました。`);
                    
                    if(room.host.readyState === WebSocket.OPEN) {
                        room.host.send(JSON.stringify({
                            type: 'newChat',
                            from: 'システム',
                            message: 'あなたが新しいホストになりました。設定を変更できます。',
                            isNotification: true
                        }));
                    }
                }
                
                const lobbyState = getLobbyState(room);
                
                if (room.gameState === 'IN_GAME' && wasPlayer) {
                    room.gameState = 'LOBBY';
                    room.playerO = null;
                    room.playerX = null;
                    broadcast(room, {
                        type: 'opponentDisconnected',
                        lobby: lobbyState,
                        roomId: ws.roomId,
                        newHostUsername: newHostUsername
                    });
                    broadcast(room, {
                        type: 'newChat',
                        from: 'システム',
                        message: `対戦者 ${username} が切断したため、試合は中断されました。`,
                        isNotification: true
                    });
                } else {
                    broadcast(room, { 
                        type: 'lobbyUpdate', 
                        lobby: lobbyState,
                        newHostUsername: newHostUsername
                    });
                }
                broadcast(room, {
                    type: 'newChat',
                    from: 'システム',
                    message: `${username} が退出しました。`,
                    isNotification: true
                });
            }
        }
    });
});
