// Render サーバーコード (v10.0: ゲーム切替基盤、オセロスタブ追加)
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
    });
}

// 〇×ゲームのデフォルト設定
const ticTacToeSettings = {
    boardSize: 3,
    playerOrder: 'random',
    limitMode: false,
    highlightOldest: false,
};

// オセロのデフォルト設定
const othelloSettings = {
    boardSize: 8, // オセロは8x8固定
    playerOrder: 'host_o', // 黒(O)が先手固定
    limitMode: false,
    highlightOldest: false,
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
                
                // ▼▼▼ 修正: ゲームタイプに応じて設定を読み込む ▼▼▼
                const gameType = data.gameType === 'othello' ? 'othello' : 'tictactoe';
                const defaultSettings = (gameType === 'othello') ? othelloSettings : ticTacToeSettings;
                
                const settings = { 
                    ...defaultSettings, 
                    ...(data.settings || {}),
                    isPublic: data.settings.isPublic ?? true,
                    maxPlayers: Math.max(2, Math.min(100, data.settings.maxPlayers || 10))
                };
                
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
                    maxPlayers: settings.maxPlayers,
                    gameType: gameType // ▼▼▼ 新規: ゲームタイプ ▼▼▼
                };
                
                newRoom.players.set(ws, { username: username, mark: 'SPECTATOR', slotCooldownUntil: 0 });
                rooms.set(roomId, newRoom);
                ws.roomId = roomId;

                ws.send(JSON.stringify({ 
                    type: 'roomJoined', 
                    isHost: true,
                    mark: 'SPECTATOR',
                    lobby: getLobbyState(newRoom),
                    roomId: roomId,
                    gameType: newRoom.gameType // ▼▼▼ 新規 ▼▼▼
                }));
                console.log(`[${roomId}] ${username} が ${gameType} ルームを作成しました。`);
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
                
                joinedRoom.players.set(ws, { username: username, mark: 'SPECTATOR', slotCooldownUntil: 0 });
                ws.roomId = roomId;

                ws.send(JSON.stringify({ 
                    type: 'roomJoined', 
                    isHost: (joinedRoom.host === ws),
                    mark: 'SPECTATOR',
                    lobby: getLobbyState(joinedRoom),
                    roomId: roomId,
                    gameType: joinedRoom.gameType // ▼▼▼ 新規 ▼▼▼
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
                    // 〇×ゲームの設定のみ更新（オセロは未対応）
                    if (room.gameType === 'tictactoe') {
                         room.settings = { ...room.settings, ...(data.settings || {}) };
                         room.settings.maxPlayers = Math.max(2, Math.min(100, room.settings.maxPlayers || 10));
                         room.maxPlayers = room.settings.maxPlayers;
                    }
                    
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
                            inGame: room.gameState !== 'LOBBY',
                            gameType: room.gameType // ▼▼▼ 新規 ▼▼▼
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

                if (playerInfo.slotCooldownUntil && Date.now() < playerInfo.slotCooldownUntil) {
                    const remaining = Math.ceil((playerInfo.slotCooldownUntil - Date.now()) / 1000);
                    ws.send(JSON.stringify({ type: 'error', message: `除外されたため、あと${remaining}秒間スロットに参加できません。` }));
                    return;
                }

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
                playerInfo.isReadyForMatch = false; 
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

            case 'setReady': {
                if (!room || !playerInfo) return;
                
                if (room.playerO !== ws && room.playerX !== ws) {
                    playerInfo.isReadyForMatch = false;
                    ws.send(JSON.stringify({ type: 'error', message: 'スロットに入ってください。' }));
                    return;
                }
                
                playerInfo.isReadyForMatch = data.isReady;
                console.log(`[${ws.roomId}] ${playerInfo.username} is ${data.isReady ? 'READY' : 'NOT READY'}`);
                
                broadcast(room, { type: 'lobbyUpdate', lobby: getLobbyState(room) });
                
                if (!room.playerO || !room.playerX) return;
                
                const playerOInfo = room.players.get(room.playerO);
                const playerXInfo = room.players.get(room.playerX);

                if (playerOInfo && playerXInfo && playerOInfo.isReadyForMatch && playerXInfo.isReadyForMatch) {
                    console.log(`[${ws.roomId}] 試合開始 (${room.gameType})`);
                    room.gameState = 'IN_GAME';
                    resetReadyStates(room);
                    
                    let oPlayer = room.playerO;
                    let xPlayer = room.playerX;
                    
                    // ▼▼▼ 〇×ゲームの先手後手ロジック ▼▼▼
                    if (room.gameType === 'tictactoe') {
                        const order = room.settings.playerOrder;
                        const hostWs = room.host;
                        
                        if (order === 'host_o' && hostWs === room.playerX) {
                            [oPlayer, xPlayer] = [xPlayer, oPlayer];
                        } else if (order === 'host_x' && hostWs === room.playerO) {
                            [oPlayer, xPlayer] = [xPlayer, oPlayer];
                        } else if (order === 'random' && Math.random() < 0.5) {
                            [oPlayer, xPlayer] = [xPlayer, oPlayer];
                        }
                    }
                    // ▼▼▼ オセロはO(黒)が先手固定 ▼▼▼
                    else if (room.gameType === 'othello') {
                         // Oが黒, Xが白
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
                            myMark: mark,
                            gameType: room.gameType // ▼▼▼ 新規 ▼▼▼
                        }));
                    });
                }
                break;
            }
            
            case 'move': {
                if (!room || room.gameState !== 'IN_GAME' || !playerInfo) return;
                
                // ▼▼▼ 修正: ゲームタイプで分岐 ▼▼▼
                if (data.gameType === 'tictactoe') {
                    const expectedMark = (ws === room.playerO) ? 'O' : 'X';
                    broadcast(room, { 
                        type: 'boardUpdate', 
                        cellIndex: data.cellIndex,
                        player: expectedMark,
                        gameType: 'tictactoe' // ▼▼▼ 新規 ▼▼▼
                    });
                }
                // TODO: 'othello' のムーブ処理
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
            
            case 'returnToLobby': {
                if (!room || !playerInfo) return; 
                
                if (ws === room.playerO) {
                    room.playerO = null;
                }
                if (ws === room.playerX) {
                    room.playerX = null;
                }
                playerInfo.mark = 'SPECTATOR';
                playerInfo.isReadyForMatch = false;

                if (room.gameState === 'POST_GAME' && !room.playerO && !room.playerX) {
                    room.gameState = 'LOBBY';
                    console.log(`[${ws.roomId}] 両者がロビーに戻りました。`);
                }

                broadcast(room, { 
                    type: 'lobbyUpdate',
                    lobby: getLobbyState(room)
                });
                break;
            }

            // ▼▼▼ 新規: ゲーム切り替え ▼▼▼
            case 'changeGame': {
                if (!room || room.host !== ws) return; // ホストのみ
                
                const newGameType = data.gameType === 'othello' ? 'othello' : 'tictactoe';
                room.gameType = newGameType;
                
                // ゲームタイプに応じてデフォルト設定をリセット
                if (newGameType === 'othello') {
                    room.settings = { ...othelloSettings, maxPlayers: room.settings.maxPlayers, isPublic: room.settings.isPublic };
                } else {
                    room.settings = { ...ticTacToeSettings, maxPlayers: room.settings.maxPlayers, isPublic: room.settings.isPublic };
                }
                
                console.log(`[${ws.roomId}] Game changed to ${newGameType}`);
                
                // 全員にゲーム変更と設定変更を通知
                broadcast(room, { 
                    type: 'gameChanged', 
                    gameType: room.gameType,
                    settings: room.settings // 新しいデフォルト設定を送信
                });
                break;
            }

            case 'kickPlayer': {
                if (!room || !playerInfo || room.host !== ws) return; // ホストのみ
                
                const usernameToKick = data.username;
                let kickedWs = null;
                let kickedPlayerInfo = null;
                
                room.players.forEach((p, w) => {
                    if (p.username === usernameToKick) {
                        kickedWs = w;
                        kickedPlayerInfo = p;
                    }
                });
                
                if (kickedWs) {
                    let wasInSlot = false;
                    if (room.playerO === kickedWs) {
                        room.playerO = null;
                        wasInSlot = true;
                    } else if (room.playerX === kickedWs) {
                        room.playerX = null;
                        wasInSlot = true;
                    }

                    if (wasInSlot) {
                        // スロットから除外
                        kickedPlayerInfo.mark = 'SPECTATOR';
                        kickedPlayerInfo.isReadyForMatch = false;
                        kickedPlayerInfo.slotCooldownUntil = Date.now() + 10000; // 10秒のクールダウン
                        
                        console.log(`[${ws.roomId}] ${playerInfo.username} が ${usernameToKick} をスロットから除外しました。`);
                        
                        broadcast(room, {
                            type: 'newChat',
                            from: 'システム',
                            message: `${usernameToKick} がホストによってスロットから除外されました。`,
                            isNotification: true
                        });
                        broadcast(room, { type: 'lobbyUpdate', lobby: getLobbyState(room) });
                    
                    } else if (kickedWs !== room.host) {
                        // 観戦者をキック（ルームから除外）
                        console.log(`[${ws.roomId}] ${playerInfo.username} が ${usernameToKick} をキックしました。`);
                        kickedWs.send(JSON.stringify({ type: 'error', message: 'ホストによってルームからキックされました。' }));
                        kickedWs.close(); // 観戦者は強制切断
                    }
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
                
                if ((room.gameState === 'IN_GAME' || room.gameState === 'POST_GAME') && wasPlayer) {
                    room.gameState = 'LOBBY'; 
                    room.playerO = null;
                    room.playerX = null;
                    resetReadyStates(room); 
                    
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
