const WebSocket = require('ws');

const port = process.env.PORT || 8080;
const wss = new WebSocket.Server({ port: port, host: '0.0.0.0' });

const rooms = new Map();
const MAX_ROOMS = 100; // サーバー全体の最大ルーム数
const ROOM_INACTIVITY_LIMIT = 60 * 60 * 1000; // ★追加: 60分 (ミリ秒)

function generateRoomId() {
    return Math.random().toString(36).substring(2, 6).toUpperCase();
}

// === 接続維持（Heartbeat） ===
function noop() {}

function heartbeat() {
    this.isAlive = true;
}

// 30秒ごとに生存確認 (通信断の検知)
const heartbeatInterval = setInterval(function ping() {
    wss.clients.forEach(function each(ws) {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping(noop);
    });
}, 30000);

// ★追加: 60分操作がないルームを削除する定期処理 (1分ごとにチェック)
const cleanupInterval = setInterval(() => {
    const now = Date.now();
    rooms.forEach((room, roomId) => {
        if (now - room.lastActivity > ROOM_INACTIVITY_LIMIT) {
            console.log(`ルーム ${roomId} は60分間操作がなかったため削除します。`);
            
            // ルーム内の全員に通知して切断またはロビーへ戻す
            broadcast(room, { 
                type: 'error', 
                message: '60分間操作がなかったため、ルームはタイムアウトにより削除されました。' 
            });
            
            // ルーム情報の削除
            rooms.delete(roomId);
            
            // 接続しているクライアントのルームID情報をクリア
            room.players.forEach((_, ws) => {
                ws.roomId = null;
            });
        }
    });
}, 60000);

wss.on('close', function close() {
    clearInterval(heartbeatInterval);
    clearInterval(cleanupInterval); // ★追加
});

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
        hostUsername: hostInfo ? hostInfo.username : '',
        playerColors: room.playerColors
    };
}

function resetReadyStates(room) {
    room.players.forEach(playerInfo => {
        playerInfo.isReadyForMatch = false;
    });
}

// 設定オブジェクト
const ticTacToeSettings = {
    boardSize: 3,
    playerOrder: 'assigned',
    limitMode: false,
    highlightOldest: false,
};

const othelloSettings = {
    boardSize: 8,
    playerOrder: 'assigned',
    limitMode: false,
    highlightOldest: false,
};

// =================================================================
// ゲームロジック
// =================================================================

const ticTacToeLogic = {
    generateWinningConditions: (size) => {
        const conditions = [];
        const winLength = (size === 3) ? 3 : (size === 4 ? 4 : 5);
        for (let r = 0; r < size; r++) {
            for (let c = 0; c <= size - winLength; c++) {
                const horizontal = [];
                for (let i = 0; i < winLength; i++) horizontal.push(r * size + (c + i));
                conditions.push(horizontal);
                const vertical = [];
                for (let i = 0; i < winLength; i++) vertical.push((c + i) * size + r);
                conditions.push(vertical);
            }
        }
        for (let r = 0; r <= size - winLength; r++) {
            for (let c = 0; c <= size - winLength; c++) {
                const diag1 = [];
                const diag2 = [];
                for (let i = 0; i < winLength; i++) {
                    diag1.push((r + i) * size + (c + i));
                    diag2.push((r + i) * size + (c + winLength - 1 - i));
                }
                conditions.push(diag1);
                conditions.push(diag2);
            }
        }
        return conditions;
    },
    
    initializeBoard: (room) => {
        const size = room.settings.boardSize;
        room.boardState = Array(size * size).fill('');
        room.winningConditions = ticTacToeLogic.generateWinningConditions(size);
        room.oQueue = [];
        room.xQueue = [];
        room.currentPlayer = 'O';
    },

    handleMove: (room, ws, cellIndex) => {
        const player = (ws === room.playerO) ? 'O' : 'X';
        
        if (room.currentPlayer !== player) return;
        if (cellIndex < 0 || cellIndex >= room.boardState.length || room.boardState[cellIndex] !== '') return;

        if (room.settings.limitMode && room.settings.boardSize === 3) {
            const queue = (player === 'O') ? room.oQueue : room.xQueue;
            if (queue.length >= 3) {
                const indexToClear = queue.shift();
                room.boardState[indexToClear] = '';
            }
            queue.push(cellIndex);
        }

        room.boardState[cellIndex] = player;
        
        if (ticTacToeLogic.checkWin(room, player)) {
            broadcast(room, {
                type: 'boardUpdate',
                boardState: room.boardState,
                player: player,
                nextPlayer: null,
                gameType: 'tictactoe',
                cellIndex: cellIndex
            });
            
            room.gameState = 'POST_GAME';
            broadcast(room, { type: 'gameOver', result: player, gameType: 'tictactoe' });
            resetReadyStates(room);
            return;
        }
        
        if (ticTacToeLogic.checkDraw(room)) {
            broadcast(room, {
                type: 'boardUpdate',
                boardState: room.boardState,
                player: player,
                nextPlayer: null,
                gameType: 'tictactoe',
                cellIndex: cellIndex
            });
            
            room.gameState = 'POST_GAME';
            broadcast(room, { type: 'gameOver', result: 'DRAW', gameType: 'tictactoe' });
            resetReadyStates(room);
            return;
        }

        const nextPlayer = (player === 'O') ? 'X' : 'O';
        room.currentPlayer = nextPlayer;
        
        broadcast(room, {
            type: 'boardUpdate',
            boardState: room.boardState,
            player: player,
            nextPlayer: nextPlayer,
            gameType: 'tictactoe',
            cellIndex: cellIndex
        });
    },
    
    checkWin: (room, player) => {
        for (const condition of room.winningConditions) {
            if (condition.every(index => room.boardState[index] === player)) {
                return true;
            }
        }
        return false;
    },
    
    checkDraw: (room) => {
        return !room.boardState.includes('');
    }
};

const othelloLogic = {
    directions: [-9, -8, -7, -1, 1, 7, 8, 9],

    initializeBoard: (room) => {
        room.boardState = Array(64).fill('');
        room.boardState[27] = 'X';
        room.boardState[36] = 'X';
        room.boardState[28] = 'O';
        room.boardState[35] = 'O';
        room.currentPlayer = 'O';
    },
    
    getFlips: (board, index, player) => {
        const opponent = player === 'O' ? 'X' : 'O';
        const flips = [];
        const row = Math.floor(index / 8);
        const col = index % 8;
        
        othelloLogic.directions.forEach(dir => {
            const path = [];
            let i = index + dir;
            if (i < 0 || i > 63) return;
            let r = Math.floor(i / 8);
            let c = i % 8;
            if (Math.abs(c - col) > 1) return;

            while (r >= 0 && r < 8 && c >= 0 && c < 8 && board[i] === opponent) {
                path.push(i);
                const prev_i = i;
                i += dir;
                if (i < 0 || i > 63) { path.length = 0; break; }
                r = Math.floor(i / 8);
                c = i % 8;
                if (Math.abs(c - (prev_i % 8)) > 1) { path.length = 0; break; }
            }
            
            if (i >= 0 && i < 64 && board[i] === player && path.length > 0) {
                flips.push(...path);
            }
        });
        return flips;
    },

    getValidMoves: (board, player) => {
        const moves = [];
        for (let i = 0; i < 64; i++) {
            if (board[i] === '') {
                if (othelloLogic.getFlips(board, i, player).length > 0) {
                    moves.push(i);
                }
            }
        }
        return moves;
    },

    getScores: (board) => {
        let oScore = 0;
        let xScore = 0;
        board.forEach(cell => {
            if (cell === 'O') oScore++;
            else if (cell === 'X') xScore++;
        });
        return { O: oScore, X: xScore };
    },

    handleMove: (room, ws, cellIndex) => {
        const player = (ws === room.playerO) ? 'O' : 'X';
        const opponent = player === 'O' ? 'X' : 'O';
        
        if (room.currentPlayer !== player) return;
        if (cellIndex < 0 || cellIndex > 63 || room.boardState[cellIndex] !== '') return;
        
        const flips = othelloLogic.getFlips(room.boardState, cellIndex, player);
        
        if (flips.length === 0) return;

        room.boardState[cellIndex] = player;
        flips.forEach(i => room.boardState[i] = player);
        
        let nextPlayer = opponent;
        
        let validMoves = othelloLogic.getValidMoves(room.boardState, nextPlayer);
        if (validMoves.length === 0) {
            nextPlayer = player;
            validMoves = othelloLogic.getValidMoves(room.boardState, nextPlayer);
            
            if (validMoves.length === 0) {
                broadcast(room, {
                    type: 'boardUpdate',
                    boardState: room.boardState,
                    player: player,
                    nextPlayer: null,
                    gameType: 'othello'
                });

                room.gameState = 'POST_GAME';
                const scores = othelloLogic.getScores(room.boardState);
                let result = 'DRAW';
                if (scores.O > scores.X) result = 'O';
                else if (scores.X > scores.O) result = 'X';
                
                broadcast(room, { 
                    type: 'gameOver', 
                    result: result, 
                    scores: scores,
                    boardState: room.boardState,
                    gameType: 'othello' 
                });
                resetReadyStates(room);
                return;
            }
            
            broadcast(room, {
                type: 'boardUpdate',
                boardState: room.boardState,
                player: player,
                nextPlayer: opponent,
                gameType: 'othello'
            });

            broadcast(room, {
                type: 'passTurn',
                passedPlayer: opponent,
                nextPlayer: nextPlayer,
                boardState: room.boardState
            });
            room.currentPlayer = nextPlayer;
            return;
        }

        room.currentPlayer = nextPlayer;
        broadcast(room, {
            type: 'boardUpdate',
            boardState: room.boardState,
            player: player,
            nextPlayer: nextPlayer,
            gameType: 'othello'
        });
    }
};


// === 接続処理 ===

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', heartbeat);

    ws.roomId = null;

    ws.on('message', (message) => {
        let data;
        try { data = JSON.parse(message); } catch (e) { console.error('Invalid JSON:', e); return; }
        
        // ★追加: メッセージを受信するたびに、そのルームの最終操作時刻を更新
        const room = rooms.get(ws.roomId);
        if (room) {
            room.lastActivity = Date.now();
        }
        
        const playerInfo = room ? room.players.get(ws) : null;

        switch (data.type) {
            case 'createRoom': {
                if (rooms.size >= MAX_ROOMS) {
                    ws.send(JSON.stringify({ type: 'error', message: 'サーバーが混雑しています。ルームを作成できません。' }));
                    return;
                }

                let roomId;
                do { roomId = generateRoomId(); } while (rooms.has(roomId));
                
                const gameType = data.gameType === 'othello' ? 'othello' : 'tictactoe';
                const defaultSettings = (gameType === 'othello') ? othelloSettings : ticTacToeSettings;
                
                const settings = { 
                    ...defaultSettings, 
                    ...(data.settings || {}),
                    isPublic: data.settings.isPublic ?? true,
                    maxPlayers: Math.max(2, Math.min(100, data.settings.maxPlayers || 10))
                };
                settings.playerOrder = data.settings.playerOrder || defaultSettings.playerOrder;

                const username = data.username.substring(0, 20) || `User${Math.floor(Math.random() * 1000)}`;
                
                const newRoom = {
                    id: roomId, 
                    settings: settings,
                    players: new Map(),
                    playerO: null,
                    playerX: null,
                    playerColors: { O: null, X: null },
                    gameState: 'LOBBY',
                    host: ws,
                    isPublic: settings.isPublic, 
                    maxPlayers: settings.maxPlayers,
                    gameType: gameType, 
                    boardState: [], 
                    currentPlayer: 'O',
                    oQueue: [],
                    xQueue: [],
                    lastActivity: Date.now() // ★追加: 作成時刻を初期値として記録
                };
                
                newRoom.players.set(ws, { 
                    username: username, 
                    mark: 'SPECTATOR', 
                    slotCooldownUntil: 0,
                    lastMessageTime: 0,
                    messageTimestamps: []
                });
                rooms.set(roomId, newRoom);
                ws.roomId = roomId;

                ws.send(JSON.stringify({ 
                    type: 'roomJoined', 
                    isHost: true,
                    mark: 'SPECTATOR',
                    lobby: getLobbyState(newRoom),
                    roomId: roomId,
                    gameType: newRoom.gameType 
                }));
                console.log(`[${roomId}] ${username} が ${gameType} ルームを作成しました。`);
                break;
            }
            
            case 'joinRoom': {
                const roomId = data.roomId.toUpperCase();
                const username = data.username.substring(0, 20) || `User${Math.floor(Math.random() * 1000)}`;
                const joinedRoom = rooms.get(roomId);

                if (!joinedRoom) {
                    ws.send(JSON.stringify({ type: 'error', message: 'ルームが見つかりません。' })); return;
                }
                
                if (joinedRoom.players.size >= joinedRoom.maxPlayers) {
                    ws.send(JSON.stringify({ type: 'error', message: 'ルームは満員です。' })); return;
                }

                // 参加時もアクティビティ更新（上の共通処理で更新済みだが、部屋がない場合のエラー前に弾かれるのでここで更新する必要はない）
                
                let mark = 'SPECTATOR';
                if (joinedRoom.gameState !== 'LOBBY') {
                    mark = 'SPECTATOR';
                }
                
                joinedRoom.players.set(ws, { 
                    username: username, 
                    mark: mark, 
                    slotCooldownUntil: 0,
                    lastMessageTime: 0,
                    messageTimestamps: []
                });
                ws.roomId = roomId;

                // ★追加: 参加アクションでも時刻更新
                joinedRoom.lastActivity = Date.now();

                const response = { 
                    type: 'roomJoined', 
                    isHost: (joinedRoom.host === ws),
                    mark: mark,
                    lobby: getLobbyState(joinedRoom),
                    roomId: roomId,
                    gameType: joinedRoom.gameType
                };
                
                if (joinedRoom.gameState !== 'LOBBY') {
                    response.currentBoardState = joinedRoom.boardState;
                    response.currentPlayer = joinedRoom.currentPlayer;
                }
                ws.send(JSON.stringify(response));
                
                broadcast(joinedRoom, { type: 'lobbyUpdate', lobby: getLobbyState(joinedRoom) }, ws);
                broadcast(joinedRoom, {
                    type: 'newChat',
                    from: 'システム',
                    message: `${username} が入室しました。`,
                    isNotification: true
                }, ws);
                break;
            }

            case 'updateSettings': {
                if (room && room.host === ws) {
                    room.settings = { ...room.settings, ...(data.settings || {}) };
                    room.settings.maxPlayers = Math.max(2, Math.min(100, room.settings.maxPlayers || 10));
                    room.maxPlayers = room.settings.maxPlayers;
                    
                    broadcast(room, { 
                        type: 'settingsUpdated', 
                        settings: room.settings 
                    });
                    broadcast(room, { 
                        type: 'lobbyUpdate',
                        lobby: getLobbyState(room)
                    });
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
                            gameType: room.gameType 
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

                let targetSlot = data.slot; 
                let requestedColor = data.color || null; 
                
                const opponentSlot = targetSlot === 'O' ? 'X' : 'O';
                const opponentColor = room.playerColors[opponentSlot];
                
                if (requestedColor && opponentColor === requestedColor) {
                    requestedColor = null; 
                }

                if (targetSlot === 'O' && !room.playerO) {
                    room.playerO = ws;
                    playerInfo.mark = 'O';
                    room.playerColors.O = requestedColor;
                } else if (targetSlot === 'X' && !room.playerX) {
                    room.playerX = ws;
                    playerInfo.mark = 'X';
                    room.playerColors.X = requestedColor;
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: 'スロットは既に埋まっています。' }));
                    return;
                }
                
                const lobbyState = getLobbyState(room);
                ws.send(JSON.stringify({ type: 'youTookSlot', slot: targetSlot, lobby: lobbyState }));
                broadcast(room, { type: 'lobbyUpdate', lobby: lobbyState }, ws);
                break;
            }
            
            case 'leaveSlot': {
                if (!room || !playerInfo) return;

                if (room.playerO === ws) {
                    room.playerO = null;
                    room.playerColors.O = null;
                } else if (room.playerX === ws) {
                    room.playerX = null;
                    room.playerColors.X = null;
                } else {
                    return;
                }
                
                playerInfo.mark = 'SPECTATOR';
                playerInfo.isReadyForMatch = false; 
                
                const lobbyState = getLobbyState(room);
                ws.send(JSON.stringify({ type: 'youLeftSlot', lobby: lobbyState }));
                broadcast(room, { type: 'lobbyUpdate', lobby: lobbyState }, ws);
                break;
            }

            case 'updateColor': {
                if (!room || !playerInfo) return;
                
                let mySlot = '';
                if (room.playerO === ws) mySlot = 'O';
                else if (room.playerX === ws) mySlot = 'X';
                else return; 

                const opponentSlot = mySlot === 'O' ? 'X' : 'O';
                const newColor = data.color; 

                if (newColor !== null && room.playerColors[opponentSlot] === newColor) {
                    ws.send(JSON.stringify({ type: 'error', message: 'その色は相手が使用中です。' }));
                    return;
                }

                room.playerColors[mySlot] = newColor;
                
                const lobbyState = getLobbyState(room);
                broadcast(room, { type: 'lobbyUpdate', lobby: lobbyState });
                break;
            }
            
            case 'chat': {
                if (!room || !playerInfo || !data.message) return;
                const now = Date.now();
                
                if (now - playerInfo.lastMessageTime < 1000) {
                    ws.send(JSON.stringify({ type: 'error', message: 'メッセージの送信が早すぎます。1秒待ってください。' }));
                    return;
                }
                
                playerInfo.messageTimestamps = playerInfo.messageTimestamps.filter(t => now - t < 60000); 
                if (playerInfo.messageTimestamps.length >= 20) {
                    ws.send(JSON.stringify({ type: 'error', message: 'メッセージの送信が多すぎます。1分間に20回までです。' }));
                    return;
                }

                playerInfo.lastMessageTime = now;
                playerInfo.messageTimestamps.push(now);
                
                const messageContent = data.message.substring(0, 200);

                broadcast(room, {
                    type: 'newChat',
                    from: playerInfo.username,
                    message: messageContent
                }, ws);
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
                broadcast(room, { type: 'lobbyUpdate', lobby: getLobbyState(room) });
                
                if (!room.playerO || !room.playerX) return;
                
                const playerOInfo = room.players.get(room.playerO);
                const playerXInfo = room.players.get(room.playerX);

                if (playerOInfo && playerXInfo && playerOInfo.isReadyForMatch && playerXInfo.isReadyForMatch) {
                    room.gameState = 'IN_GAME';
                    resetReadyStates(room);
                    
                    let oPlayer = room.playerO;
                    let xPlayer = room.playerX;
                    
                    const order = room.settings.playerOrder;
                    if (order === 'random' && Math.random() < 0.5) {
                        [oPlayer, xPlayer] = [xPlayer, oPlayer];
                    }
                    
                    room.playerO = oPlayer;
                    room.playerX = xPlayer;

                    if (room.gameType === 'tictactoe') {
                        ticTacToeLogic.initializeBoard(room);
                    } else if (room.gameType === 'othello') {
                        othelloLogic.initializeBoard(room);
                    }
                    
                    room.players.forEach((p, w) => {
                        let mark = 'SPECTATOR';
                        if (w === oPlayer) mark = 'O';
                        else if (w === xPlayer) mark = 'X';
                        p.mark = mark;
                        
                        w.send(JSON.stringify({ 
                            type: 'matchStarting', 
                            firstPlayer: 'O',
                            myMark: mark,
                            gameType: room.gameType 
                        }));
                    });
                }
                break;
            }
            
            case 'move': {
                if (!room || room.gameState !== 'IN_GAME' || !playerInfo) return;
                if (data.gameType === 'tictactoe') {
                    ticTacToeLogic.handleMove(room, ws, data.cellIndex);
                } else if (data.gameType === 'othello') {
                    othelloLogic.handleMove(room, ws, data.cellIndex);
                }
                break;
            }
            
            case 'gameOver': {
                if (!room || room.gameState !== 'IN_GAME') return;
                room.gameState = 'POST_GAME';
                broadcast(room, { type: 'gameOver', result: data.result, gameType: data.gameType, scores: data.scores });
                resetReadyStates(room);
                break;
            }
            
            case 'surrender': {
                if (!room || room.gameState !== 'IN_GAME' || !playerInfo) return;

                let winnerMark = 'DRAW';
                if (ws === room.playerO) winnerMark = 'X';
                else if (ws === room.playerX) winnerMark = 'O';

                if (winnerMark !== 'DRAW') {
                    room.gameState = 'POST_GAME';
                    let scores = null;
                    if(data.gameType === 'othello') {
                        scores = othelloLogic.getScores(room.boardState);
                    }
                    broadcast(room, { type: 'gameOver', result: winnerMark, gameType: data.gameType, scores: scores });
                    resetReadyStates(room);
                }
                break;
            }
            
            case 'returnToLobby': {
                if (!room || !playerInfo) return; 
                
                if (ws === room.playerO) {
                    room.playerO = null;
                    room.playerColors.O = null;
                }
                if (ws === room.playerX) {
                    room.playerX = null;
                    room.playerColors.X = null;
                }
                playerInfo.mark = 'SPECTATOR';
                playerInfo.isReadyForMatch = false;

                if (room.gameState === 'POST_GAME' && !room.playerO && !room.playerX) {
                    room.gameState = 'LOBBY';
                    resetReadyStates(room);
                }

                broadcast(room, { type: 'lobbyUpdate', lobby: getLobbyState(room) });
                break;
            }

            case 'changeGame': {
                if (!room || room.host !== ws) return;
                
                const newGameType = data.gameType === 'othello' ? 'othello' : 'tictactoe';
                room.gameType = newGameType;
                
                if (newGameType === 'othello') {
                    room.settings = { ...othelloSettings, maxPlayers: room.settings.maxPlayers, isPublic: room.settings.isPublic };
                } else {
                    room.settings = { ...ticTacToeSettings, maxPlayers: room.settings.maxPlayers, isPublic: room.settings.isPublic };
                }
                room.settings.playerOrder = data.playerOrder || (newGameType === 'othello' ? 'assigned' : 'assigned');
                
                broadcast(room, { 
                    type: 'gameChanged', 
                    gameType: room.gameType,
                    settings: room.settings 
                });
                broadcast(room, { type: 'lobbyUpdate', lobby: getLobbyState(room) });
                break;
            }

            case 'kickPlayer': {
                if (!room || !playerInfo || room.host !== ws) return;
                
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
                        room.playerColors.O = null;
                        wasInSlot = true;
                    } else if (room.playerX === kickedWs) {
                        room.playerX = null;
                        room.playerColors.X = null;
                        wasInSlot = true;
                    }

                    if (wasInSlot) {
                        kickedPlayerInfo.mark = 'SPECTATOR';
                        kickedPlayerInfo.isReadyForMatch = false;
                        kickedPlayerInfo.slotCooldownUntil = Date.now() + 10000;
                        
                        broadcast(room, {
                            type: 'newChat',
                            from: 'システム',
                            message: `${usernameToKick} がホストによってスロットから除外されました。`,
                            isNotification: true
                        });
                        broadcast(room, { type: 'lobbyUpdate', lobby: getLobbyState(room) });
                    
                    } else if (kickedWs !== room.host) {
                        kickedWs.send(JSON.stringify({ type: 'error', message: 'ホストによってルームからキックされました。' }));
                        kickedWs.close();
                    }
                }
                break;
            }
        }
    });

    ws.on('close', () => {
        const room = rooms.get(ws.roomId);
        if (room) {
            // 退室でも更新する（誰か一人が抜けても、まだ誰か残っていれば部屋はアクティブ）
            room.lastActivity = Date.now();

            const playerInfo = room.players.get(ws);
            const username = playerInfo ? playerInfo.username : '不明なユーザー';
            
            room.players.delete(ws);
            
            let wasPlayer = false;
            if (room.playerO === ws) {
                room.playerO = null;
                room.playerColors.O = null;
                wasPlayer = true;
            }
            if (room.playerX === ws) {
                room.playerX = null;
                room.playerColors.X = null;
                wasPlayer = true;
            }
            
            if (room.players.size === 0) {
                rooms.delete(ws.roomId);
            } else {
                let newHostUsername = null;
                if (room.host === ws) {
                    room.host = room.players.keys().next().value;
                    const newHostInfo = room.players.get(room.host);
                    newHostUsername = newHostInfo.username;
                    
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
                    room.playerColors = {O: null, X: null};
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
