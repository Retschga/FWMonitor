'use strict';
module.exports = function (_httpServer, _httpsServer, _bot, setIgnoreNextAlarm, getIgnoreNextAlarm) {
	// ----------------  STANDARD LIBRARIES ---------------- 
	const express = require('express');
	const router = express.Router();
	const path = require('path');
	const axios = require('axios');
	const fs = require('fs');
	const util = require('util');
	const readdir = util.promisify(fs.readdir);
	const openrouteservice = require("openrouteservice-js");
	const debug = require('debug')('appAPI');
	const sharp = require('sharp');

	// ---------------- AUTHIFICATION ---------------- 
	const bcrypt = require('bcryptjs');
	const generator = require('generate-password');

	// ----------------  WEB PUSH NOTIFICATIONS ---------------- 
	const webNotifications = require('../webNotifications');

	// ----------------  Datenbank ---------------- 
	const db = require('../database')();

	// ----------------  KALENDER/FWVV ---------------- 
	var calendar = require('../calendar')()
	const fwvv = require('../fwvvAnbindung')();

	const fileExists = async path => !!(await fs.promises.stat(path).catch(e => false));
	const pathSlideshow = './filesHTTP/images/slideshow/';
	const pathTelegramImg = './telegramBilder/';
	const createThumbnail = async (path, file) => {return new Promise(async (resolve, reject) => {
		sharp(path + file)
		.resize(200)
		.toFile(path + 'thumbnail-' + file, (err, resizeImage) => {
			if (err) {
				reject("Thumbnail generation ERROR: " + err);
			} else {
				resolve(resizeImage);
			}
		});
	})}




	async function loadHydrantenData(lat, lng) {
		// URL Overpass-API für Hydranten    siehe Ovepass turbo
		let overpassHydrantenUrl = "https://overpass-api.de/api/interpreter?data=" +
		"[out:json][timeout:25];(" +
		"node[%22emergency%22=%22fire_hydrant%22](around:3000," + lat + "," + lng + ");" +
		"node[%22emergency%22=%22water_tank%22](around:3000," + lat + "," + lng + ");" +
		"node[%22emergency%22=%22suction_point%22](around:3000," + lat + "," + lng + ");" +
		");out;%3E;out%20skel%20qt;";

		// Make a request for a user with a given ID
		let response = await axios.get(overpassHydrantenUrl)
			.catch(function (error) {
				console.log("Load Hydranten", error);
			})
		
		let features = [];

		if(!response) return features;

		var responseJSON = response.data;

		// Hydranten ausgeben
		let dataIn = responseJSON["elements"];
		

		for (let i = 0; i < dataIn.length; i++) {

			var dataElement = dataIn[i];
			var name = "";

			name = dataElement["tags"]["fire_hydrant:type"];

			if (dataElement["tags"]["emergency"] == "water_tank")
				name = "water_tank"				

			if(dataElement["tags"]["water_source"] == "pond")
				name = "pond";

			if(dataElement["tags"]["emergency"] == "suction_point")
				name = "pond";


			features.push({
				"type": "Feature",
				"geometry": {
					"type": "Point",
					"coordinates": [dataElement["lon"], dataElement["lat"]]
				},
				"properties": {
					"title": name,
					"iconcategory": "icons"
				}
			});

		}

		return features;
	}


	// ---- Dateien ----
	router.get('/filesHTTPS/:file', function (req, res) {
		res.sendFile(req.params.file, { root: './filesHTTPS' });
	});
	router.get('/filesHTTPS/images/:file', function (req, res) {
		res.sendFile(req.params.file, { root: './filesHTTPS/images' });
	});
	router.get('/filesHTTPS/javascripts/:file', function (req, res) {
		res.sendFile(req.params.file, { root: './filesHTTPS/javascripts' });
	});
	router.get('/filesHTTPS/splashscreens/:file', function (req, res) {
		res.sendFile(req.params.file, { root: './filesHTTPS/splashscreens' });
	});
	router.get('/filesHTTPS/images/icons/:file', function (req, res) {
		res.sendFile(req.params.file, { root: './filesHTTPS/images/icons' });
	});
	// ADMIN
	router.get('/filesHTTP/images/slideshow/:file', async function (req, res) {
		if (!req.session.isAdmin) {
			res.status(500).send({ error: 'Kein Admin' });
			return;
		}
		if(!await fileExists(pathSlideshow + "thumbnail-" + req.params.file)) {
			await createThumbnail(pathSlideshow, req.params.file);
		}
		res.sendFile('thumbnail-' + req.params.file, { root: pathSlideshow });
	});
	router.get('/telegramBilder/:file', async function (req, res) {
		if (!req.session.isAdmin) {
			res.status(500).send({ error: 'Kein Admin' });
			return;
		}
		if(!await fileExists(pathTelegramImg + "thumbnail-" + req.params.file)) {
			await createThumbnail(pathTelegramImg, req.params.file);
		}
		res.sendFile('thumbnail-' + req.params.file, { root: pathTelegramImg });
	});


	// ---- Kalender ----
	// get Kalender
	router.get('/api/kalender', async function (req, res) {
		let getAll = req.query.getAll;
		if (getAll != 'true')
			getAll = undefined;
		else 
			getAll = true;

		let termine = await calendar.getCalendarByPattern(getAll)
			.catch((err) => { console.error('[appIndex] Kalender Fehler', err) });

		res.json(termine);
	});

	// get Kalendergruppen
	router.get('/api/kalender/gruppen', async function (req, res) {
		let rows = await db.getKalendergruppen().catch((err) => { console.error('[appIndex] DB Fehler', err) });
		if (rows == undefined) {
			res.send("Fehler");
			return;
		}

		res.json(rows);
	});

	// post Kalendergruppen ADMIN
	router.post('/api/kalender/gruppen/set', async function (req, res) {
		if (!req.session.isAdmin) {
			res.status(500).send({ error: 'Kein Admin' });
			return;
		}

		for (let i = 0; i < req.body.length; i++) {
			console.log((req.body[i].id, req.body[i].name, req.body[i].pattern));
			await db.setKalendergruppen(req.body[i].id, req.body[i].name, req.body[i].pattern)
				.catch((err) => {
					console.error('[appIndex] DB Fehler', err)
				});
		}
		res.json({ data: 'ok' });
	});

	// post Kalender Event KALENDER
	router.post('/api/kalender/event/set', async function (req, res) {
		if (!(/*req.session.isAdmin ||*/ req.session.kalender)) {	

			res.status(500).send({ error: 'Kein Admin / Kalender' });
			return;
		}

		if(req.body.id != -1) {
			await db.updateKalender(req.body.id, req.body.summary, req.body.start, req.body.remind, req.body.group)
			.catch((err) => {
				console.error('[appIndex] DB Fehler', err)
			});
		} else {
			await db.insertKalender(req.body.summary, req.body.start, req.body.remind, req.body.group)
			.catch((err) => {
				console.error('[appIndex] DB Fehler', err)
			});
		}
		
		res.json({ data: 'ok' });
	});

	// delete Kalender KALENDER
	router.get('/api/kalender/delete', async function (req, res) {
		if (!(/*req.session.isAdmin ||*/ req.session.kalender)) {	
			res.status(500).send({ error: 'Kein Admin' });
			return;
		}

		let id = req.query.id;

		if (id) {
			db.deleteKalender(id);
		}

		res.send('OK'); return;

	});


	// ---- Alarm ----
	// post Alarmgruppen ADMIN
	router.post('/api/alarm/gruppen/set', async function (req, res) {
		if (!req.session.isAdmin) {
			res.status(500).send({ error: 'Kein Admin' });
			return;
		}

		for (let i = 0; i < req.body.length; i++) {
			console.log('\n', (req.body[i].id, req.body[i].name, req.body[i].pattern));
			await db.setAlarmgruppen(req.body[i].id, req.body[i].name, req.body[i].pattern)
				.catch((err) => {
					console.error('[appIndex] DB Fehler', err)
				});
		}
		res.json({ data: 'ok' });
	});

	function getAlarmColor(einsatzstichwort) {
		let stichwort = einsatzstichwort.toLowerCase();

		// Info/Sonstiges - Green
		if(stichwort.includes("inf") || stichwort.includes("1nf") || stichwort.includes("son"))
			return '3';

		// THL - Blue
		if(stichwort.includes("thl"))
			return '2';		

		// Brand - Red
		if(stichwort.includes("b "))
			return '0';

		// Rettungsdienst - Orange
		if(stichwort.includes("rd"))
			return '1';

		// Rest - Red
		return "0";
	}

	// get Alarmliste
	router.get('/api/alarm/list', async function (req, res) {
		let offset = req.query.offset;
		let count = req.query.count;
		if (offset == undefined || count == undefined) {
			res.status(500).send({ error: 'No Params' });
			return;
		}

		let rows = await db.getAlarmList(offset, count).catch((err) => { console.error('[appIndex] DB Fehler', err) });
		if (rows == undefined) {
			res.send("Fehler");
			return;
		}

		let ret = new Array();

		for (let row of rows) {
			ret.push([row.schlagwort, row.strasse, row.ort, row.date, row.einsatzstichwort, row.id, getAlarmColor(row.einsatzstichwort)]);
		}

		res.json(ret);
	});

	// get Alarmgruppen ADMIN
	router.get('/api/alarm/gruppen', async function (req, res) {
		if (!req.session.isAdmin) {
			res.status(500).send({ error: 'Kein Admin' });
			return;
		}

		let rows = await db.getAlarmgruppenAll().catch((err) => { console.error('[appIndex] DB Fehler', err) });
		if (rows == undefined) {
			res.send("Fehler");
			return;
		}
		res.json(rows);
	});

	// get Alarm
	var hydrantenCache = {};
	var strassenCache = {};
	var gebaeudeCache = {};
	var routeCache = {};
	router.get('/api/alarm', async function (req, res) {
		let id = req.query.id;
		if (id == undefined)
			res.status(500).send({ error: 'No Params' })

		let user;
		if (req.query.id) {
			user = [{pattern:`*{{EINSATZSTICHWORT}}* {{KARTE}} {{KARTE_EMG}} {{FAX}}
			_> {{SCHLAGWORT}}_
			_> {{OBJEKT}}_
			_> {{STRASSE}}_
			_> {{ORTSTEIL}}_
			_> {{ORT}}_
			{{newline}}
			*Bemerkung:*
			_{{BEMERKUNG}}_{{newline}}
			*Einsatzmittel:*
			_{{EINSATZMITTEL_EIGEN}}_
			_{{EINSATZMITTEL_ANDERE}}_`}];
		} else {
			user = await db.getUserAlarmPattern(req.session.telegramID).catch((err) => { console.error('[appIndex] DB Fehler', err) });
		}
		
		let rows = await db.getAlarmAll(req.query.id).catch((err) => { console.error('[appIndex] DB Fehler', err) });
		if (rows == undefined) {
			res.send("Fehler");
			return;
		}
		rows = rows[0];


		// URL Overpass-API für Hydranten    siehe Ovepass turbo
		let overpassStrassenUrl = `http://overpass-api.de/api/interpreter?data=
			[out:json][timeout:25];
			(
			way[%22name%22~%22${rows.strasse.replace(/ss|ß/g, '(ss|%C3%9F)')}%22]
			(around:1000,${rows.lat}, ${rows.lng});
			);
			out geom;
			%3E;
			out%20skel%20qt;`;		
			
		var overpassGebaudeUrl = `http://overpass-api.de/api/interpreter?data=
			[out:json][timeout:25];
			(
			way[building]
			(around:200,${rows.lat}, ${rows.lng});
			);
			out geom;
			%3E;`;

		
		if (hydrantenCache[id] == undefined)
			hydrantenCache[id] = await loadHydrantenData(rows.lat, rows.lng);

		async function loadStrassenData() {
			// Make a request for a user with a given ID
			let response = await axios.get(overpassStrassenUrl)
				.catch(function (error) {
					console.log("Load Strassen", error);
				});

			let responseJSON = response.data;

			let dataIn = responseJSON["elements"];
			let polylinePoints = [];

//			console.log("strassenData", overpassStrassenUrl, dataIn)

			if (dataIn.length < 1)
				return;

			for (let i = 0; i < dataIn.length; i++) {

				var dataElement = dataIn[i];

				if (dataElement.type == "way") {

					let polyarr = [];
					for (let j = 0; j < dataElement.geometry.length; j++) {

						polyarr.push([dataElement.geometry[j].lat, dataElement.geometry[j].lon]);

					}

					polylinePoints.push(polyarr);
				}


			}

			strassenCache[id] = polylinePoints;
		}
		if (strassenCache[id] == undefined && rows.isAddress != 1 && rows.strasse != "" && rows.strasse != undefined)
			await loadStrassenData();

		async function loadGebaudeData() {
			// Make a request for a user with a given ID
			let response = await axios.get(overpassGebaudeUrl)
				.catch(function (error) {
					console.log("Load Gebäude", error);
				});

			let responseJSON = response.data;

			var dataIn = responseJSON["elements"];

			gebaeudeCache[id] = dataIn;
		}
		if (gebaeudeCache[id] == undefined && rows.isAddress == 1)
			await loadGebaudeData();


		if(process.env.FW_KOORD != "" && process.env.ORS_KEY != "") {
			var Directions = new openrouteservice.Directions({
				api_key: process.env.ORS_KEY,
			});
			if (routeCache[id] == undefined && rows.lat != "" && rows.lng != "") {
				let direct = await Directions.calculate(
					{
						coordinates: [process.env.FW_KOORD.split(','), [rows.lng, rows.lat]],
						profile: 'driving-car',
						extra_info: ["waytype"],
						radiuses: [1000,5000],
						format: 'json'
					}
				)
				.catch(function(err) {
					var str = "An error occured: " + err;
					console.log("[appAPI] Route Error: " + str);
					// TODO Sende Info bei Fehler an admin
				});

	//			console.log(direct);
				routeCache[id] = JSON.stringify(direct);
			} 
		} else {
			console.log("[appAPI] keine FW_KOORD oder kein ORS_KEY angegeben -> keine Route berechnet");
		}
		

		// Gruppenpattern
		var pattern = user[0].pattern;

		if (pattern == undefined) {
			pattern = "";
		}

		let ret = {
			einsatzstichwort: null,
			schlagwort: null,
			objekt: null,
			strasse: null,
			ortsteil: null,
			ort: null,
			bemerkung: null,
			cars1: null,
			cars2: null,
			fax: pattern.indexOf('{{FAX}}') != -1 ? true : false,
			map: pattern.indexOf('{{KARTE}}') != -1 ? true : false,
			mapEmg: pattern.indexOf('{{KARTE_EMG}}') != -1 ? true : false,
			hydrantenCache: hydrantenCache[id],
			strassenCache: strassenCache[id],
			gebaeudeCache: gebaeudeCache[id],
			routeCache: routeCache[id],
			color: "0"
		};

		if (pattern.indexOf('{{EINSATZSTICHWORT}}') !== -1)
			ret.einsatzstichwort = rows.einsatzstichwort;

		if (pattern.indexOf('{{SCHLAGWORT}}') !== -1)
			ret.schlagwort = rows.schlagwort;

		if (pattern.indexOf('{{OBJEKT}}') !== -1)
			ret.objekt = rows.objekt;

		if (pattern.indexOf('{{STRASSE}}') !== -1)
			ret.strasse = rows.strasse;

		if (pattern.indexOf('{{ORTSTEIL}}') !== -1)
			ret.ortsteil = rows.ortsteil;

		if (pattern.indexOf('{{ORT}}') !== -1)
			ret.ort = rows.ort;

		if (pattern.indexOf('{{BEMERKUNG}}') !== -1)
			ret.bemerkung = rows.bemerkung;

		if (pattern.indexOf('{{EINSATZMITTEL_EIGEN}}') !== -1 && rows.cars1 != undefined)
			ret.cars1 = rows.cars1.split(',');

		if (pattern.indexOf('{{EINSATZMITTEL_ANDERE}}') !== -1 && rows.cars2 != undefined)
			ret.cars2 = rows.cars2.split(',');

		if (pattern.indexOf('{{KARTE}}') !== -1) {
			ret.lat = rows.lat;
			ret.lng = rows.lng;
		}

		ret.color = getAlarmColor(rows.einsatzstichwort);

		ret.date = rows.date;


		res.json(ret);
	});

	// set ignoreNextAlarm ADMIN
	router.get('/api/alarm/ignorenext/set', async function (req, res) {
		if (!req.session.isAdmin) {
			res.status(500).send({ error: 'Kein Admin' });
			return;
		}

		let value = req.query.value;

		if (value == 'true' || value == true)
			setIgnoreNextAlarm(true);
		else
			setIgnoreNextAlarm(false);

		res.send('OK'); return;

	});

	// get ignoreNextAlarm ADMIN
	router.get('/api/alarm/ignorenext', async function (req, res) {
		if (!req.session.isAdmin) {
			res.status(500).send({ error: 'Kein Admin' });
			return;
		}

		res.json(getIgnoreNextAlarm()); return;

	});

	// get Hydranten
	router.get('/api/hydranten.geojson', async function (req, res) {
		let lat = req.query.lat;
		let lng = req.query.lng;
		if (lat == undefined || lng == undefined) {
			res.status(500).send({ error: 'No Params' });
			return;
		}

		let features = await loadHydrantenData(lat, lng);

		res.json(features);
	});


	// ---- Status ----
	// get Status
	router.get('/api/status', async function (req, res) {
		let rows = await db.getUserStatusByTelId(req.session.telegramID).catch((err) => { console.error('[appIndex] DB Fehler', err) });
		if (rows == undefined) {
			res.send("Fehler");
			return;
		}

		res.json(rows[0]);
	});

	// set Verfügbar
	router.get('/api/verfuegbarkeit/set', async function (req, res) {
		let status = req.query.status;
		let days = req.query.days;
		if (status == undefined || days == undefined) {
			res.status(500).send({ error: 'No Params' });
			return;
		}

		var result =  new Date();
		result.setDate(result.getDate() + parseInt(days, 10));
		if (days == -1 || status == 1) {
			result = "";
		}


 
		await db.setUserStatus(req.session.telegramID, status, result).catch((err) => { console.error('[appIndex] DB Fehler', err) });

		db.getUserByTelId(req.session.telegramID)
			.then((rows) => {
				if (rows[0] != undefined) {
					if (status == 2)
						_httpServer[0].wss.broadcast('st_nichtverf', rows[0].name + " " + rows[0].vorname + "%" +
							rows[0].stAGT + "," + rows[0].stGRF + "," + rows[0].stMA + "," + rows[0].stZUGF);
					if (status == 1)
						_httpServer[0].wss.broadcast(
							'st_verf', rows[0].name + " " + rows[0].vorname + "%" + rows[0].stAGT +
							"," + rows[0].stGRF + "," + rows[0].stMA + "," + rows[0].stZUGF
						);
				}
			})

		res.send('OK');
	});

	// get Verfügbarkeit
	router.get('/api/verfuegbarkeit', async function (req, res) {
		let rows_allUsers = await db.getUserAll().catch((err) => { console.error('[appIndex] DB Fehler', err) });
		if (rows_allUsers == undefined) {
			res.send("Fehler");
			return;
		}

		var st_verf = new Array();
		var st_verfNum = 0;
		var st_nichtverf = new Array();
		var st_nichtverfNum = 0;

		rows_allUsers.forEach(function (element) {
			if (parseInt(element.allowed) == 1 && (parseInt(element.statusHidden) != 1 || req.session.isAdmin == true)) {
				if (element.status == 2) {
					st_nichtverf.push(element.name + " " + element.vorname);
					st_nichtverfNum += 1;
				}
				else {
					st_verf.push(element.name + " " + element.vorname);
					st_verfNum += 1;
				}
			}
		});

		res.json({ numVerf: st_verfNum, numNVerf: st_nichtverfNum, nameVerf: st_verf, nameNVerf: st_nichtverf });
	});

	// post setVervPlans
	router.post('/api/verfuegbarkeit/plans/set', async function (req, res) {
		let plans = req.body.plans;
		if (plans == undefined) {
			res.status(500).send({ error: 'No Params' });
			return;
		}

		await db.setUserStatusPlan(req.session.telegramID, '{"plans":'+JSON.stringify(plans)+'}').catch((err) => { console.error('[appIndex] DB Fehler', err) });

		res.send('OK');
	});

	// get getVervPlans
	router.get('/api/verfuegbarkeit/plans', async function (req, res) {
		let rows = await db.getUserStatusPlan(req.session.telegramID).catch((err) => { console.error('[appIndex] DB Fehler', err) });
		if (rows == undefined) {
			res.send("Fehler");
			return;
		}

		res.json(rows[0]);
	});



	// ---- Benutzer ----
	// get Benutzer ADMIN
	router.get('/api/benutzer', async function (req, res) {
		if (!req.session.isAdmin) {
			res.status(500).send({ error: 'Kein Admin' });
			return;
		}

		let rows_allUsers = await db.getUserAll().catch((err) => { console.error('[appIndex] DB Fehler', err) });
		if (rows_allUsers == undefined) {
			res.send("Fehler");
			return;
		}
		res.json(rows_allUsers);
	});

	// set Einstellung ADMIN
	router.get('/api/benutzer/einstellung/set', async function (req, res) {
		if (!req.session.isAdmin) {
			res.status(500).send({ error: 'Kein Admin' });
			return;
		}

		let id = req.query.id;
		let setting = req.query.setting;
		let value = req.query.value;
		if (setting == undefined || value == undefined) {
			res.status(500).send({ error: 'No Params' });
			return;
		}

		console.log(setting, value);

		switch (setting) {
			case 'admin':
				db.setUserColumn(id, "admin", value)
					.then(() => { res.send('OK'); return; })
					.catch((err) => { console.error('[appApi] Datenbank Fehler: ', err) });
				break;
			case 'kalender':
				db.setUserColumn(id, "kalender", value)
					.then(() => { res.send('OK'); return; })
					.catch((err) => { console.error('[appApi] Datenbank Fehler: ', err) });
				break;
			case 'stAGT':
				db.setUserColumn(id, "stAGT", value)
					.then(() => { res.send('OK'); return; })
					.catch((err) => { console.error('[appApi] Datenbank Fehler: ', err) });
				break;
			case 'stMA':
				db.setUserColumn(id, "stMA", value)
					.then(() => { res.send('OK'); return; })
					.catch((err) => { console.error('[appApi] Datenbank Fehler: ', err) });
				break;
			case 'stGRF':
				db.setUserColumn(id, "stGRF", value)
					.then(() => { res.send('OK'); return; })
					.catch((err) => { console.error('[appApi] Datenbank Fehler: ', err) });
				break;
			case 'stZUGF':
				db.setUserColumn(id, "stZUGF", value)
					.then(() => { res.send('OK'); return; })
					.catch((err) => { console.error('[appApi] Datenbank Fehler: ', err) });
				break;
			case 'drucker':
				db.setUserColumn(id, "drucker", value)
					.then(() => { res.send('OK'); return; })
					.catch((err) => { console.error('[appApi] Datenbank Fehler: ', err) });
				break;
			case 'software':
				db.setUserColumn(id, "softwareInfo", value)
					.then(() => { res.send('OK'); return; })
					.catch((err) => { console.error('[appApi] Datenbank Fehler: ', err) });
				break;
			case 'telefonliste':
				db.setUserColumn(id, "telefonliste", value)
					.then(() => { res.send('OK'); return; })
					.catch((err) => { console.error('[appApi] Datenbank Fehler: ', err) });
				break;
			case 'gruppe':
				db.changeUserGroup(id, value)
					.then(() => { res.send('OK'); return; })
					.catch((err) => { console.error('[appApi] Datenbank Fehler: ', err) });
				break;
			case 'kalGr':
				db.setUserColumn(id, "kalenderGroups", value)
					.then(() => { res.send('OK'); return; })
					.catch((err) => { console.error('[appApi] Datenbank Fehler: ', err) });
				break;
			case 'loeschen':
				await _bot[0].removeUser(id);
				res.send('OK'); return;
				break;
			case 'freigeben':
				await _bot[0].allowUser(id);
				res.send('OK'); return;
				break;


		}
	});

	// set Notifications
	router.get('/api/benutzer/notifications/set', async function (req, res) {
		let value = req.query.value;
		if (value == undefined) {
			res.status(500).send({ error: 'No Params' });
			return;
		}

		value = value;

		await db.setUserNotifications(req.session.telegramID, value).catch((err) => { console.error('[appIndex] DB Fehler', err) });

		res.send('OK');
	});

	// set Erinnerungen
	router.get('/api/benutzer/erinnerungen/set', async function (req, res) {
		let value = req.query.value;
		if (value == undefined) {
			res.status(500).send({ error: 'No Params' });
			return;
		}
		if (value == 'true')
			value = 1;
		else
			value = 0;

		await db.changeUserReminders(req.session.telegramID, value).catch((err) => { console.error('[appIndex] DB Fehler', err) });

		res.send('OK');
	});

	// set StatusHidden
	router.get('/api/benutzer/statushidden/set', async function (req, res) {
		let value = req.query.value;
		if (value == undefined) {
			res.status(500).send({ error: 'No Params' });
			return;
		}
		if (value == 'true')
			value = 1;
		else
			value = 0;

		await db.setUserStatusHidden(req.session.telegramID, value).catch((err) => { console.error('[appIndex] DB Fehler', err) });

		res.send('OK');
	});


	// ---- Auto - Bildschirme ----
	// get Autos ADMIN
	router.get('/api/auto', async function (req, res) {
		if (!req.session.isAdmin) {
			res.status(500).send({ error: 'Kein Admin' });
			return;
		}

		let rows_allAutos = await db.getAutoAll().catch((err) => { console.error('[appIndex] DB Fehler', err) });
		if (rows_allAutos == undefined) {
			res.send("Fehler");
			return;
		}
		res.json(rows_allAutos);
	});

	// add Autos ADMIN
	router.get('/api/auto/add', async function (req, res) {
		if (!req.session.isAdmin) {
			res.status(500).send({ error: 'Kein Admin' });
			return;
		}

		db.addAuto('Neues Auto Display', '', '')
			.then(() => { res.send('OK'); return; })
			.catch((err) => { console.error('[appApi] Datenbank Fehler: ', err) });
		
	});

	// delete Autos ADMIN
	router.get('/api/auto/delete', async function (req, res) {
		if (!req.session.isAdmin) {
			res.status(500).send({ error: 'Kein Admin' });
			return;
		}

		let id = req.query.id;
		if (id == undefined) {
			res.status(500).send({ error: 'No Params' });
			return;
		}

		db.deleteAuto(id)
			.then(() => { res.send('OK'); return; })
			.catch((err) => { console.error('[appApi] Datenbank Fehler: ', err) });

		
	});

	// new Password ADMIN
	router.get('/api/auto/password/new', async function (req, res) {
		if (!req.session.isAdmin) {
			res.status(500).send({ error: 'Kein Admin' });
			return;
		}

		let id = req.query.id;
		if (id == undefined) {
			res.status(500).send({ error: 'No Params' });
			return;
		}

		let password = generator.generate({
			length: 10,
			numbers: true,
			excludeSimilarCharacters: true
		});

		bcrypt.hash(password, 10, async (err, hash) => {
			if (err) {

				console.error('[appAPI] #einstell_appLogin Fehler', err);

			} else {

				db.setAutoPassword(id, hash)
					.then(() => { res.json({"pw": password}); return; })
					.catch((err) => { console.error('[appApi] Datenbank Fehler: ', err) });

			}
		});

		
	});

	// set Einstellung ADMIN
	router.get('/api/auto/einstellung/set', async function (req, res) {
		if (!req.session.isAdmin) {
			res.status(500).send({ error: 'Kein Admin' });
			return;
		}

		let id = req.query.id;
		let setting = req.query.setting;
		let value = req.query.value;
		if (setting == undefined || value == undefined) {
			res.status(500).send({ error: 'No Params' });
			return;
		}

		console.log(setting, value);

		switch (setting) {
			case 'name':
				db.setAutoColumn(id, "name", value)
					.then(() => { res.send('OK'); return; })
					.catch((err) => { console.error('[appApi] Datenbank Fehler: ', err) });
				break;		
			case 'appBenutzer':
				db.setAutoColumn(id, "appBenutzer", value)
					.then(() => { res.send('OK'); return; })
					.catch((err) => { console.error('[appApi] Datenbank Fehler: ', err) });
				break;		

		}
	});
	

	// ---- Statistik ----
	// get Statistik
	router.get('/api/statistik', async function (req, res) {
		let year = req.query.year;
		if (year == undefined) {
			res.status(500).send({ error: 'No Params' });
			return;
		}

		let rows = await db.getStatistik(year).catch((err) => { console.error('[appIndex] DB Fehler', err) });
		if (rows == undefined) {
			res.send("Fehler");
			return;
		}

		let ret = new Array();
		var d = new Date();
		var options = { year: 'numeric' };
		var date = d.toLocaleDateString('de-DE', options);

		var sum = 0;

		for (let row of rows) {
			sum += parseInt(row.number);
			ret.push([
				row.number,
				(row.einsatzstichwort == "" ? 'kein Stichwort' : row.einsatzstichwort)

			]);
		}

		res.json(ret);
	});

	// get Einsatzzeit
	router.get('/api/einsatzzeit', async function (req, res) {

		let year = req.query.year;
		if (year == undefined) {
			res.status(500).send({ error: 'No Params' });
			return;
		}

		let rows = await db.getUserByTelId(req.session.telegramID).catch((err) => { console.error('[appIndex] DB Fehler', err) });

		let zeit = await fwvv.getEinsatzZeit(rows[0].name, rows[0].vorname, year)
			.then((arr) => {

				res.json({ hour: Math.floor(arr[0] / 60), minute: (arr[0] % 60), num: arr[1] });

			})
			.catch((error) => {
				console.log("Fehler: Daten konnten nicht geladen werden.");
			});


	});

	
	// ---- Präsentation ----
	// get getPraesentationen ADMIN
	router.get('/api/praesentationen', async function (req, res) {
		if (!req.session.isAdmin) {
			res.status(500).send({ error: 'Kein Admin' });
			return;
		}

		var path = "./filesHTTP/praesentationen/";
		var src = [];
		var items = await fs.promises.readdir(path)
			.catch(err => console.log(err));
		for (var i = 0; i < items.length; i++) {
			if (items[i] != '.gitignore')
				src.push(items[i]);
		}

		res.json(JSON.stringify(src)); return;

	});

	// set setPraesentationenAction ADMIN
	router.get('/api/praesentationen/action/set', async function (req, res) {
		if (!req.session.isAdmin) {
			res.status(500).send({ error: 'Kein Admin' });
			return;
		}

		let action = req.query.action;
		let value = req.query.value;
		if (action == undefined) {
			res.status(500).send({ error: 'No Params' });
			return;
		}

		console.log(action);

		switch (action) {
			case 'load':
				_httpServer[0].wss.broadcast('praes_load', value);
				console.log('praes_load', value);
				break;
			case 'end':
				_httpServer[0].wss.broadcast('praes_end',);
				break;
			case 'play':
				_httpServer[0].wss.broadcast('praes_play');
				break;
			case 'pause':
				_httpServer[0].wss.broadcast('praes_pause');
				break;
			case 'next':
				_httpServer[0].wss.broadcast('praes_next');
				break;
			case 'prev':
				_httpServer[0].wss.broadcast('praes_prev');
				break;
		}

		res.json(JSON.stringify({ seite: 1 })); return;

	});


	// ---- Verbundene Geräte ADMIN ----
	// get getConnectedClients ADMIN
	router.get('/api/admin/clients/connected', async function (req, res) {
		if (!req.session.isAdmin) {
			res.status(500).send({ error: 'Kein Admin' });
			return;
		}

		let ret = [];

		ret.push({"id": "-1", "type": `{"type":"MainSoftware",
					"name":"FWmonitor - Haupt Software",
					"info":"v${process.env.VERSION} ${process.env.VERSION != process.env.VERSION_REMOTE && process.env.VERSION_REMOTE != '' ? '(v'+process.env.VERSION_REMOTE+' Verfügbar)' : ''}",
					"actions":[{"id": "7"}, {"id": "-1", "key": "Startzeit", "value": "${startTime}"}]}`
				});
		
		_httpServer[0].wss.getOpenSockets().forEach(function each(client) {				
			if(client.wsType) {
				ret.push({"id": client.id, "type": client.wsType});
			}
		});
		_httpsServer[0].wss.getOpenSockets().forEach(function each(client) {
			if(client.wsType) {
				ret.push({"id": client.id, "type": client.wsType});
			}
		});		

		res.json(ret); return;

	});
	
	// set setClientAction ADMIN
	router.get('/api/admin/clients/action/set', async function (req, res) {
		if (!req.session.isAdmin) {
			res.status(500).send({ error: 'Kein Admin' });
			return;
		}

		let id = req.query.id;
		let action = req.query.action;
		let value = req.query.value;
		if (!action || !id) {
			res.status(500).send({ error: 'No Params' });
			return;
		}

		if(id == -1) {
			switch (action) {
				case 'restart':
					setTimeout(function () {
						console.log("exiting")
						process.exit(1);
					}, 1000);
					break;
			}
			res.json("ok"); return;
		}

		let dat = "";
		switch (action) {
			case 'kalElem':
				dat = "kal_elemnum|"+value;
				break;
			case 'kalReload':
				dat = "kal_reload|";
				break;
			case 'reload':
				dat = "reload|";
				break;
			case 'letzteralarm':
				dat = "letzteralarm|";
				break;
			case 'zurueck':
				dat = "zurueck|";
				break;
			case 'restart':
				dat = "rebootScreen|";
				break;
			case 'updateScript':
				dat = "updateScript|";
				break;
		}		
		_httpServer[0].wss.sendToID(id, dat);
		_httpsServer[0].wss.sendToID(id, dat);

		res.json("ok"); return;

	});


	// ---- Diashow ----
	// get detDiashow ADMIN
	router.get('/api/diashow', async function (req, res) {
		if (!req.session.isAdmin) {
			res.status(500).send({ error: 'Kein Admin' });
			return;
		}

		let ret = [];

		let path = "./filesHTTP/images/slideshow/";
		let src = [];
		let items = await readdir(path)
		.catch((err) => { console.error('[appAPI] fs.readdir Fehler ', err) });
		for (var i = 0; i < items.length; i++) {
			if(items[i] != '.gitignore' && items[i].indexOf('.') != -1 && items[i].indexOf('thumbnail') == -1)
				src.push("/app/filesHTTP/images/slideshow/" + items[i]);
		}
		ret.push(src);

		path = "./telegramBilder/";
		src = [];
		items = await readdir(path)
		.catch((err) => { console.error('[appAPI] fs.readdir Fehler ', err) });
		for (var i = 0; i < items.length; i++) {
			if(items[i] != '.gitignore' && items[i].indexOf('.') != -1 && items[i].indexOf('thumbnail') == -1)
				src.push("/app/telegramBilder/" + items[i]);
		}
		ret.push(src);

		res.json(ret); return;

	});
	// post setDiashowFreigabeTrue ADMIN
	router.post('/api/diashow/freigabe/set/true', async function (req, res) {
		if (!req.session.isAdmin) {
			res.status(500).send({ error: 'Kein Admin' });
			return;
		}
		if (!req.body.src) return;
		let file = req.body.src.split(/[\\/]/).pop();
		debug("Freigabe TRUE: " + file);
		fs.rename(pathTelegramImg + file, pathSlideshow + file, function (err) {
			if (err) throw err
			console.log('Successfully renamed - AKA moved!');			
		});
		fs.rename(pathTelegramImg + "thumbnail-" + file, pathSlideshow + "thumbnail-" + file, function (err) {
			if (err) throw err
			console.log('Successfully renamed Thumbnail - AKA moved!');
		});
		res.json({ data: 'ok' });
	});
	// post setDiashowFreigabeFalse ADMIN
	router.post('/api/diashow/freigabe/set/false', async function (req, res) {
		if (!req.session.isAdmin) {
			res.status(500).send({ error: 'Kein Admin' });
			return;
		}
		if (!req.body.src) return;
		let file = req.body.src.split(/[\\/]/).pop();
		debug("Freigabe FALSE: " + file);
		fs.rename(pathSlideshow + file, pathTelegramImg + file, function (err) {
			if (err) throw err
			console.log('Successfully renamed - AKA moved!');
		});		
		fs.rename(pathSlideshow + "thumbnail-" + file, pathTelegramImg + "thumbnail-" + file, function (err) {
			if (err) throw err
			console.log('Successfully renamed Thumbnail - AKA moved!');

		});		
		res.json({ data: 'ok' });
	});
	// post setDiashowDelete ADMIN
	router.post('/api/diashow/freigabe/set/delete', async function (req, res) {
		if (!req.session.isAdmin) {
			res.status(500).send({ error: 'Kein Admin' });
			return;
		}
		if (!req.body.src) return;
		let file = req.body.src.split(/[\\/]/).pop();
		debug("Gelöscht: " + file);
		fs.unlinkSync(pathTelegramImg + file);
		fs.unlinkSync(pathTelegramImg + "thumbnail-" + file);
		res.json({ data: 'ok' });
	});


	// ---- Telefonliste ----
	// get Telefonliste TELEFONLISTE
	router.get('/api/telefonliste', async function (req, res) {

		if (!req.session.telefonliste) {
			res.status(500).send({ error: 'Kein Admin' });
			return;
		}

		try {
			let arr = await fwvv.getTelNr()
			res.json(arr);
		} catch (error) {
			res.send("Fehler");
		}		

	});

	

	
	// ---- Service Worker ----
	router.get('/appClient.js', function (req, res) {
		res.render('appClient', {
			page: '',
			data: {
				VAPID_PUBLIC: process.env.VAPID_PUBLIC
			}
		});
	});
	router.get('/appWorker.js', async function (req, res) {
		let rows = await db.getUserStatusByTelId(req.session.telegramID).catch((err) => { console.error('[appIndex] DB Fehler', err) });
		if (rows == undefined) {
			res.send("Fehler");
			return;
		}

		res.setHeader('Content-Type', 'application/javascript');
		res.render('appWorker', {
			page: '',
			data: {
				telegramID: req.session.telegramID
			}
		});
	});

	router.post('/subscribe', function (req, res) {

		// Note: In this route we only check for an endpoint. If you require payload support, make sure you check for the auth and p256dh keys as well.
		const isValidSaveRequest = (req, res) => {
			// Check the request body has at least an endpoint.
			if (!req.body || !req.body.endpoint) {
				// Not a valid subscription.
				res.status(400);
				res.setHeader('Content-Type', 'application/json');
				res.send(JSON.stringify({
					error: {
						id: 'no-endpoint',
						message: 'Subscription must have an endpoint.'
					}
				}));
				return false;
			}
			return true;
		};
		isValidSaveRequest(req, res);

		if (webNotifications.subscribe(req.session.telegramID, JSON.stringify(req.body))) {
			res.setHeader('Content-Type', 'application/json');
			res.send(JSON.stringify({ data: { success: true } }));
		} else {
			res.status(500);
			res.setHeader('Content-Type', 'application/json');
			res.send(JSON.stringify({
				error: {
					id: 'unable-to-send-messages',
					message: `We were unable to send messages to all subscriptions : ` +
						`'${err.message}'`
				}
			}));
		}
	});



	return router;
}