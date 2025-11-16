// Render サーバーコード (v10.0: ゲーム切替基盤、オセロロジック実装)
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

// =================================================================
// ▼▼▼ 新規: サーバー側ゲームロジック ▼▼▼
// =================================================================

// サーバー側 〇×ゲームロジック
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
        room.currentPlayer = 'O'; // 〇×ゲームはOが先手
    },

    handleMove: (room, ws, cellIndex) => {
        const player = (ws === room.playerO) ? 'O' : 'X';
        
        // ターン確認
        if (room.currentPlayer !== player) {
            return; // ターンが違う
        }
        // マスが空か確認
        if (room.boardState[cellIndex] !== '') {
            return; // マスが空ではない
        }

        const limitMode = room.settings.limitMode;
        const boardSize = room.settings.boardSize;
        
        if (limitMode && boardSize === 3) {
            const queue = (player === 'O') ? room.oQueue : room.xQueue;
            if (queue.length >= 3) {
                const indexToClear = queue.shift();
                room.boardState[indexToClear] = '';
            }
            queue.push(cellIndex);
        }
        
        room.boardState[cellIndex] = player;
        const nextPlayer = player === 'O' ? 'X' : 'O';
        
        broadcast(room, { 
            type: 'boardUpdate', 
            cellIndex: cellIndex,
            player: player,
            nextPlayer: nextPlayer,
            gameType: 'tictactoe'
        });
        
        room.currentPlayer = nextPlayer;

        // 勝敗判定
        if (ticTacToeLogic.checkWin(room, player)) {
            room.gameState = 'POST_GAME';
            broadcast(room, { type: 'gameOver', result: player, gameType: 'tictactoe' });
            resetReadyStates(room);
        } else if (ticTacToeLogic.checkDraw(room)) {
            room.gameState = 'POST_GAME';
            broadcast(room, { type: 'gameOver', result: 'DRAW', gameType: 'tictactoe' });
            resetReadyStates(room);
        }
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

// サーバー側 オセロロジック
const othelloLogic = {
    directions: [-9, -8, -7, -1, 1, 7, 8, 9], // 8方向 (row-1,col-1), (row-1,col), (row-1,col+1), ...

    initializeBoard: (room) => {
        room.boardState = Array(64).fill('');
        room.boardState[27] = 'X'; // 白
        room.boardState[36] = 'X'; // 白
        room.boardState[28] = 'O'; // 黒
        room.boardState[35] = 'O'; // 黒
        room.currentPlayer = 'O'; // 黒(O)が先手
    },
    
    getFlips: (board, index, player, opponent) => {
        const flips = [];
        const row = Math.floor(index / 8);
        const col = index % 8;
        
        othelloLogic.directions.forEach(dir => {
            const path = [];
            let i = index + dir;
            let r = Math.floor(i / 8);
            let c = i % 8;

            // 盤面の端チェック (例: 1列目から-1(左)や-9(左上)に行けない)
            const rowDiff = Math.floor((i + 8) / 8) - Math.floor((index + 8) / 8); // -1, 0, 1
            const colDiff = (i % 8) - (index % 8); // -1, 0, 1 (ただし端をまたぐと +/- 7 になる)
            
            // 期待する移動かチェック (例: dir=-9 なら rowDiff=-1, colDiff=-1)
            const expectedRowDiff = Math.round(dir / 8); // -1, 0, 1
            let expectedColDiff = (dir % 8);
            if (expectedColDiff > 1) expectedColDiff -= 8; // 7 -> -1
            if (expectedColDiff < -1) expectedColDiff += 8; // -7 -> 1

            if (rowDiff !== expectedRowDiff || colDiff !== expectedColDiff) {
                 return; // 盤面の端を越えた
            }


            while (r >= 0 && r < 8 && c >= 0 && c < 8 && board[i] === opponent) {
                path.push(i);
                
                i += dir;
                r = Math.floor(i / 8);
                c = i % 8;
                
                // 次のマスが盤面の端をまたいでいないか再度チェック
                const nextRowDiff = Math.floor((i + 8) / 8) - Math.floor((i-dir + 8) / 8);
                const nextColDiff = (i % 8) - ((i-dir) % 8);
                if (nextRowDiff !== expectedRowDiff || nextColDiff !== expectedColDiff) {
                    break; // 盤面の端を越えた
                }
            }
            
            if (r >= 0 && r < 8 && c >= 0 && c < 8 && board[i] === player && path.length > 0) {
                flips.push(...path);
            }
        });
        return flips;
    },

    getValidMoves: (board, player) => {
        const opponent = player === 'O' ? 'X' : 'O';
        const moves = [];
        for (let i = 0; i < 64; i++) {
            if (board[i] === '') {
                if (othelloLogic.getFlips(board, i, player, opponent).length > 0) {
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
        
        if (room.currentPlayer !== player) return; // ターンが違う
        if (room.boardState[cellIndex] !== '') return; // マスが空ではない
        
        const flips = othelloLogic.getFlips(room.boardState, cellIndex, player, opponent);
        
        if (flips.length === 0) {
            ws.send(JSON.stringify({ type: 'error', message: 'そこには置けません。' }));
            return; // 無効な手
        }

        // 手を適用
        room.boardState[cellIndex] = player;
        flips.forEach(i => room.boardState[i] = player);
        
        let nextPlayer = opponent;
        
        // 相手の有効手チェック
        let validMoves = othelloLogic.getValidMoves(room.boardState, nextPlayer);
        if (validMoves.length === 0) {
            // 相手はパス
            nextPlayer = player; // ターンを自分に戻す
            validMoves = othelloLogic.getValidMoves(room.boardState, nextPlayer);
            
            if (validMoves.length === 0) {
                // 両者パス -> ゲーム終了
                room.gameState = 'POST_GAME';
                const scores = othelloLogic.getScores(room.boardState);
                let result = 'DRAW';
                if (scores.O > scores.X) result = 'O';
                else if (scores.X > scores.O) result = 'X';
                
                broadcast(room, { 
                    type: 'gameOver', 
                    result: result, 
                    scores: scores, 
                    gameType: 'othello' 
                });
                resetReadyStates(room);
                return;
            }
            
            // 相手のパスを通知
            broadcast(room, {
                type: 'passTurn',
                passedPlayer: opponent,
                nextPlayer: nextPlayer,
                boardState: room.boardState
            });
            room.currentPlayer = nextPlayer;
            return;
        }

        // 通常のターン移行
        room.currentPlayer = nextPlayer;
        broadcast(room, {
            type: 'boardUpdate',
            boardState: room.boardState,
            player: player, // 今回置いた人
            nextPlayer: nextPlayer, // 次の人
            gameType: 'othello'
        });
    }
};

// =================================================================
// ▲▲▲ 新規: サーバー側ゲームロジック ▲▲▲
// =================================================================


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
                    gameType: gameType, // ▼▼▼ 新規: ゲームタイプ ▼▼▼
                    boardState: [], // ▼▼▼ 新規: 盤面 ▼▼▼
                    currentPlayer: 'O' // ▼▼▼ 新規: 現在のターン ▼▼▼
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

                    // ▼▼▼ 修正: ゲームロジック初期化 ▼▼▼
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
                
                // ▼▼▼ 修正: ゲームタイプでロジック分岐 ▼▼▼
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
                console.log(`[${ws.roomId}] 試合終了: ${data.result}`);
                broadcast(room, { type: 'gameOver', result: data.result, gameType: data.gameType, scores: data.scores });
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
                    
                    let scores = null;
                    if(data.gameType === 'othello') {
                        scores = { O: 0, X: 0 }; // 降参なのでスコアは 0-0 で勝敗だけ
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
                // ロビー状態も更新
                 broadcast(room, { 
                    type: 'lobbyUpdate',
                    lobby: getLobbyState(room)
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
