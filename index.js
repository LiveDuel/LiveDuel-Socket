var app = require('express')();
var http = require('http').Server(app);
var io = require('socket.io')(http);
var socketioJwt = require('socketio-jwt');
require('dotenv').config({path: '../outquiz-web/.env'});
var mysql = require('mysql');
var connection = mysql.createConnection({
	host: process.env.DB_HOST,
	port: process.env.DB_PORT,
	user: process.env.DB_USERNAME,
	password: process.env.DB_PASSWORD,
	database: process.env.DB_DATABASE
});
connection.connect();
io.use(socketioJwt.authorize({
	secret: process.env.JWT_SECRET,
	handshake: true
}));
// game vars
var game_is_on = false;
var game_players_count = 0;
var game_settings;
var game_question;
var game_answers_stats = {};
var game_winners = [];
var game_interval;
io.on('connection', function (socket) {
	// moderator
	if (socket.decoded_token.moderator)
	{
		// moderator has to be validated in DB additionally
		connection.query('SELECT * FROM players WHERE id=? LIMIT 1', [socket.decoded_token.id], function (error, results) {
			if (error)
			{
				console.log(error);
				socket.disconnect('unauthorized');
				return;
			}

			if (results.length < 1 || results[0].channel_type != 'moderator')
			{
				console.log('Not a valid moderator account.');
				socket.disconnect('unauthorized');
				return;
			}
		});

		// save settings
		socket.on('mod-settings', function (settings) {
			game_settings = settings;
		});
		
		// start the show
		socket.on('mod-start', function () {
			// game is on
			game_is_on = true;
			// set interval function, that sends updated info on number of connections
			game_interval = setInterval(game_send_stats, 10000);
			// reset a lot of things
			game_players_count = 0;
			game_question = null;
			game_answers_stats = {};
			game_winners = [];
		});
		
		// received new question
		socket.on('mod-question', function (question, correct) {
			question.islast = question.game_order == game_settings.questions
			game_question = Object.assign({}, question);
			game_question.asked = new Date();
			game_question.correct = correct;
			game_answers_stats = {};
			for (var i in question.answers)
			{
				var a = question.answers[i]
				game_answers_stats[a.id] = 0;
			}
			io.emit('question', question);
		});
		// send correct answer to players and return answers stats
		socket.on('mod-correct', function (callback) {
			io.emit('correct', game_question.correct, game_answers_stats);
			callback(game_answers_stats);
		});
		// get winners
		socket.on('mod-winners', function (callback) {
			var amount = game_winners.length > 0 ? Math.round(game_settings['game-amount'] / game_winners.length * 100) : 0
			callback(amount, game_winners);
			setTimeout(function(){
				io.emit('winners', amount, game_winners);
			}, game_settings['video-delay']);
		});
		// stop the game
		socket.on('disconnect', function () {
			game_is_on = false;
			clearInterval(game_interval);
			setTimeout(function(){
				io.emit('end');
			}, game_settings['video-delay']);
		});

	}
	// normal player
	else {
		socket.player = {
			id: socket.decoded_token.id,
			username: socket.decoded_token.username,
			avatar: socket.decoded_token.avatar
		};
		
		if(game_question != null) {
			socket.player_question = 0;
			socket.player_is_playing = false;
			socket.emit('watch');
		} else {
			socket.player_question = 1;
			socket.player_is_playing = true;
		}
		
		game_players_count++;
		// player answers question
		socket.on('answer', function (answer, callback) {
			// current time
			var date = new Date();
			// seconds from moment when question was asked and answered
			var diff = (date.getTime() - game_question.asked.getTime()) / 1000;
			// check if player is in the game, answering current question and did it in proper time + 2 seconds for data transfer
			if (socket.player_is_playing 
					&& socket.player_question == game_question.game_order
					&& diff < game_settings['answer-time'] + 2)
			{
				// update answers stats
				game_answers_stats[answer]++;
				// check answer
				if (answer == game_question.correct)
				{
					// is this the last question - user is a winner
					if (game_question.islast)
					{
						game_winners.push(socket.player);
					}
					// or moving user on to the next question
					else {
						socket.player_question++;
					}
				}
				// wrong answer - kick out of the game
				else {
					socket.player_is_playing = false;
				}
				// but vote saved ok anyway
				callback(true);
				return;
			}
			// otherwise throw user out of the game
			socket.player_is_playing = false;
			// and tell that vote was not saved - too late
			callback(false);
		});
		
		// player wants to use a live
		socket.on('life', function (callback) {
			// no usage on last question
			if (game_question.islast) {
				callback(false);
				return;
			}
			// verify with DB
			connection.query('UPDATE players SET lives = lives-1 WHERE lives > 0 AND id=?', [socket.player.id], function (error, results) {
				if (error || results.changedRows < 1)
				{
					callback(false);
					return;
				}
				// bring user back in a game
				socket.player_is_playing = true;
				socket.player_question++;
				callback(true);
			});
		});
		
		// player sends a chat message
		socket.on('chat', function (msg) {
			// simply send to all connected users
			io.emit('chat', msg, socket.player);
		});

		// update counter on disconnect
		socket.on('disconnect', function () {
			game_players_count--;
			if (game_players_count < 0)
			{
				game_players_count = 0;
			}
		});
	}
});

// send game connection count to all connected users
function game_send_stats()
{
	if (game_is_on)
	{
		io.emit('stats', game_players_count);
	}
}

http.listen(3000, function () {
	console.log('listening on *:3000');
});
