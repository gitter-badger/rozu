/**
 * Webhook server
 *
 * @author Jason Mulligan <jason.mulligan@avoidwork.com>
 * @copyright 2015 
 * @link https://github.com/avoidwork/rozu#readme
 * @module rozu
 * @version 2.0.3
 */
( function () {
	"use strict";

	var ROOT = __dirname + "/../",
		ROOT_ROUTES = [],
		VERSION = "2.0.3",
		SSE = require("express-sse"),
		tenso = require("tenso"),
		keigai = require("keigai"),
		bcrypt = require("bcrypt"),
		redis = require("redis"),
		nodemailer = require("nodemailer"),
		uuid = require("node-uuid").v1,
		mpass = require("mpass"),
		config = require(ROOT + "config.json"),
		jsonpatch = require("jsonpatch").apply_patch,
		request = require("request"),
		store = keigai.store,
		util = keigai.util,
		array = util.array,
		clone = util.clone,
		deferred = util.defer,
		iterate = util.iterate,
		json = util.json,
		lru = util.lru,
		merge = util.merge,
		when = util.when,
		collections = lru(config.collection || 1000),
		sse = new SSE(),
		app, mta, clientPublish, clientSubscribe;

/**
 * Gets and/or caches data
 *
 * @method cache
 * @param  {String} id   User ID
 * @param  {String} type DataStore type
 * @return {Object}      Promise
 */
function cache (id, type) {
	var defer = deferred(),
		key = id + "_" + type,
		data = collections.get(key);

	if (data) {
		defer.resolve(data);
	} else {
		stores[type].select({user_id: id}).then(function (recs) {
			var data = recs.length === 0 ? [] : stores[type].dump(recs).map(function (i) {
				delete i.user_id;
				return i;
			});

			collections.set(id + "_" + type, data);
			defer.resolve(data);
		}, function (e) {
			defer.reject(e);
		});
	}

	return defer.promise;
}

/**
 * Collection handler
 *
 * @method collection
 * @param  {Object}   req  Client request
 * @param  {Object}   res  Client response
 * @param  {String}   type Collection type
 * @param  {Function} fn   POST validation
 * @return {Undefined}     undefined
 */
function collection (req, res, type, fn) {
	var method = req.method,
		id = req.session.passport.user.id,
		data;

	if (method == "POST") {
		data = load(type, req.body);
		data.user_id = id;

		fn(data, function (e) {
			if (e) {
				res.error(400, e.message || e);
			} else {
				collection_update(req, res, id, type, uuid(), data, config.instruction[type + "_new"]);
			}
		});
	} else if (req.session.admin) {
		res.respond(stores[type].dump());
	} else {
		collection_read(req, res, id, type);
	}
}

/**
 * Collection deletion facade
 *
 * @method collection_delete
 * @param  {Object} req  Client request
 * @param  {Object} res  Client response
 * @param  {String} user User ID
 * @param  {String} type Collection type
 * @param  {String} key  Record key
 * @return {Undefined}   undefined
 */
function collection_delete (req, res, user, type, key) {
	collections.remove(user + "_" + type);
	stores[type].del(key).then(function () {
		res.respond(config.instruction.success);
	}, function (e) {
		res.error(500, e.message || e);
		log(e, "error");
	});
}

/**
 * Collection item handler
 *
 * @method collection_item
 * @param  {Object}   req   Client request
 * @param  {Object}   res   Client response
 * @param  {String}   type  Collection type
 * @param  {Function} fn    [Optional] PATCH/PUT validation
 * @param  {Object}   links [Optional] Hash of links (HATEOAS)
 * @return {Undefined}      undefined
 */
function collection_item (req, res, type, fn, links) {
	var user = req.session.passport.user,
		id = req.body ? req.body[type.replace(regex.trailing_s, "") + "_id"] || req.url.replace(/.*\//, "") : req.url.replace(/.*\//, ""),
		method = req.method,
		admin = req.session.admin === true,
		rec = stores[type].get(id),
		data;

	if (!rec || ( rec && rec.data.user_id !== user.id && !admin )) {
		return res.error(404);
	}

	if (method == "DELETE") {
		collection_delete(req, res, user.id, type, id);
	} else if (method == "GET" || method == "HEAD" || method == "OPTIONS") {
		rec = stores[type].dump([rec])[0];

		if (!admin) {
			delete rec.user_id;
		}

		if (links !== undefined) {
			iterate(links, function (v, k) {
				rec[k] = v.replace(/:id/g, id);
			});
		}

		res.respond(rec);
	}
	else {
		if (method === "PATCH") {
			try {
				data = jsonpatch(stores[type].get(id).data, req.body);
			} catch (e) {
				return res.error(400, e.message || e);
			}

			data = load(type, data);
		} else {
			data = load(type, req.body);
		}

		data.user_id = user.id;

		fn(data, function (e) {
			if (e) {
				res.error(400, e.message || e);
			} else {
				collection_update(req, res, user.id, type, id, data);
			}
		}, method);
	}
}

/**
 * Collection facade
 *
 * @method collection
 * @param  {Object} req  Client request
 * @param  {Object} res  Client response
 * @param  {String} id   User ID
 * @param  {String} type Collection type
 * @return {Undefined}   undefined
 */
function collection_read (req, res, id, type) {
	cache(id, type).then(function (data) {
		var instruction = config.instruction[type + "_create"];

		res.respond(data.length > 0 ? data : instruction ? {instruction: instruction} : data);
	}, function (e) {
		res.error(500, e);
		log(e, "error");
	});
}

/**
 * Collection update facade
 *
 * @method collection_update
 * @param  {Object} req  Client request
 * @param  {Object} res  Client response
 * @param  {String} user User ID
 * @param  {String} type Collection type
 * @param  {String} key  Record key
 * @param  {Object} data Record data
 * @param  {Object} msg  [Optional] Instruction
 * @return {Undefined}   undefined
 */
function collection_update (req, res, user, type, key, data, msg) {
	collections.remove(user + "_" + type);

	stores[type].set(key, data, false, req.method == "PUT").then(function (rec) {
		if (!regex.invite.test(req.url)) {
			res.respond({
				id: rec.key,
				instruction: ( msg || config.instruction.success ).replace(/\:id/g, rec.key)
			});
		} else {
			res.respond({
				instruction: ( msg || config.instruction.success ).replace(/\:id/g, rec.key)
			});
		}
	}, function (e) {
		res.error(500, e.message || e);
		log(e, "error");
	});
}

/**
 * Initializes the application
 *
 * @method init
 * @param  {Object} config Tenso config
 * @return {Object} Tenso instance
 */
function init (config) {
	var deferreds = [];

	mta = nodemailer.createTransport({
		host: config.email.host,
		port: config.email.port,
		secure: config.email.secure,
		auth: {
			user: config.email.user,
			pass: config.email.pass
		}
	});

	// Caching authenticated root route
	ROOT_ROUTES = clone(config.auth.protect, true).concat(["logout", "receive"]).sort(array.sort);

	config.routes = routes;
	config.auth.local.auth = login;
	config.rate.override = rate;

	// Loading datastores
	iterate(stores, function (i) {
		deferreds.push(i.restore());
	});

	when(deferreds).then(function () {
		log("DataStores loaded", "debug");

		// Subscribing to outbound channels
		array.each(stores.webhooks.get(), function (i) {
			clientSubscribe.subscribe(config.id + "_" + i.data.name + "_send");
		});
	}, function (e) {
		log("Failed to load DataStores", "error");
		log(e, "error");
		process.exit(1);
	});

	// Connecting to redis for inbound/outbound webhooks
	clientPublish = redis.createClient(config.session.redis.port, config.session.redis.host);
	clientSubscribe = redis.createClient(config.session.redis.port, config.session.redis.host);

	array.each([clientPublish, clientSubscribe], function (i, idx) {
		i.on("connect", function () {
			log("Connected to redis to " + (idx === 0 ? "publish inbound" : "subscribe to outbound") + " webhooks", "debug");
		});

		i.on("error", function (e) {
			log(e.message || e.stack || e, "error");
		});
	});

	// Setting a message handler to route outbound webhooks
	clientSubscribe.on("message", function (channel, message) {
		send(null, null, {channel: channel, message: message});
	});

	return tenso(config);
}

/**
 * Loads data from an Object
 *
 * @method load
 * @param  {String} type Type of Object
 * @param  {Object} obj  Object to load
 * @return {Object}      Validated shape
 */
function load (type, obj) {
	var result = {};

	array.each(config.valid[type] || [], function (i) {
		if (obj[i] !== undefined) {
			result[i] = obj[i];
		}
	});

	return result;
}

/**
 * Logs a message through tenso
 *
 * @param {Mixed}  arg   String or Error
 * @param {String} level [Optional] Log level, default is "info"
 */
function log (arg, level) {
	app.server.log(arg, level);

	if (level === "error") {
		sse.send({type: "error", data: arg.stack || arg.message || arg});
	}
}

/**
 * Login handler
 *
 * @method login
 * @param  {String} username Username
 * @param  {String} password Unencrypted password
 * @param  {String} callback Callback
 * @return {Undefined}       undefined
 */
function login (username, password, callback) {
	stores.users.select({email: username, active: true, verified: true}).then(function (recs) {
		var user;

		if (recs.length === 0) {
			return callback(new Error(config.error.invalid_credentials), null);
		}

		user = stores.users.dump([recs[0]])[0];

		password_compare(password, user.password, function (e, match) {
			if (e) {
				callback(e, null);
			} else if (match) {
				callback(null, user);
			} else {
				callback(new Error(config.error.invalid_credentials), null);
			}
		});
	}, function (e) {
		callback(e, null);
	});
}

/**
 * Creates a new user account
 *
 * @method new_user
 * @param  {Object} args User attributes
 * @return {Object}      Promise
 */
function new_user (args) {
	var defer = deferred();

	if (!args.password) {
		args.password = mpass();
	}

	password_create(args.password, function (e, hash) {
		if (e) {
			defer.reject(e);
		} else {
			stores.users.set(uuid(), {
				firstname: args.firstname || "",
				lastname: args.lastname || "",
				email: args.email,
				password: hash,
				active: true,
				verified: false,
				verify_id: uuid()
			}).then(function (rec) {
				stores.verify.set(rec.data.verify_id, {user_id: rec.key}).then(function () {
					defer.resolve({user: rec, password: args.password});
				}, function (e) {
					defer.reject(e);
				});
			}, function (e) {
				defer.reject(e);
			});
		}
	});

	return defer.promise;
}

/**
 * Sends a notification
 *
 * @method notify
 * @param  {String} type     Type of notice to send, defaults to 'email'
 * @param  {Object} data     Data describing the recipient (user record)
 * @param  {String} template Message template
 * @return {Object}          Promise
 */
function notify (type, data, template, uri) {
	var defer = deferred(),
		keys, text, html;

	if (type === "email") {
		text = clone(template.text, true);
		html = clone(template.html, true);
		keys = text.match(/({{.*}})/g);

		array.each(keys, function (i) {
			var r = new RegExp(i, "g"),
				k, v;

			if (i !== "{{verify}}") {
				k = i.replace(/{{|}}/g, "");
				v = data[k];
			} else {
				v = uri + "/verify/" + data.verify_id;
			}

			text = text.replace(r, v);
			html = html.replace(r, v);
		});

		mta.sendMail({
			from: config.email.from,
			to: data.email,
			subject: template.subject,
			text: text,
			html: html
		}, function (e, info) {
			if (e) {
				log(e, "error");
				defer.reject(e);
			} else {
				defer.resolve(info.response);
			}
		});
	} else {
		defer.reject(false);
	}

	return defer.promise;
}

/**
 * Compares user input with a known password
 *
 * @method password_compare
 * @param  {String}   password User input
 * @param  {String}   hash     Hash of password
 * @param  {Function} callback Callback function
 * @return {Undefined}         undefined
 */
function password_compare (password, hash, callback) {
	bcrypt.compare(password, hash, function (e, match) {
		callback(e, match);
	});
}

/**
 * Creates a hash of a password
 *
 * @method password_create
 * @param  {String}   password User input
 * @param  {Function} callback Callback function
 * @return {Undefined}         undefined
 */
function password_create (password, callback) {
	bcrypt.genSalt(10, function (e, salt) {
		if (e) {
			callback(e, null);
		} else {
			bcrypt.hash(password, salt, function (e, hash) {
				callback(e, hash);
			});
		}
	});
}

/**
 * Profile handler
 *
 * @method profile
 * @param  {Object} req Client request
 * @param  {Object} res Client response
 * @return {Undefined} undefined
 */
function profile (req, res) {
	var user = req.session.passport.user,
		method = req.method,
		data, next;

	if (method == "DELETE") {
		stores.users.del(user.id).then(function () {
			// Destroying the session
			res.redirect("/logout");

			// Removing entities owned by user
			iterate(stores, function (store, key) {
				if (key !== "users") {
					cache(user.id, key).then(function (recs) {
						collections.remove(user.id + "_" + key);
						store.batch("del", recs.map(function (i) {
							return i.id;
						})).then(null, function (e) {
							log(e, "error");
						});
					}, function (e) {
						log(e, "error");
					});
				}
			});
		}, function (e) {
			res.error(500, e.message || e);
			log(e, "error");
		});
	} else if (method == "GET" || method == "HEAD" || method == "OPTIONS") {
		data = clone(user, true);
		delete data.active;
		delete data.id;
		delete data.password;
		delete data.verified;
		res.respond(data);
	} else {
		data = load("users", req.body);
		next = function () {
			if (method == "PATCH" && array.cast(data).length === 0) {
				res.error(400, config.error.invalid_arguments);
			} else if (method == "PUT" && ( data.firstname === undefined || data.lastname === undefined || data.email === undefined || !regex.firstname.test(data.firstname) || !regex.lastname.test(data.lastname) || !regex.email.test(data.email) )) {
				res.error(400, config.error.invalid_arguments);
			} else {
				stores.users.set(user.id, data, false, method == "PUT").then(function (rec) {
					req.session.passport.user = stores.users.dump([rec])[0];
					res.respond(config.instruction.success);
				}, function (e) {
					res.error(500, e.message || e);
					log(e, "error");
				});
			}
		};

		if (data.password === undefined) {
			next();
		} else if (regex.password.test(data.password) && req.body.old_password !== undefined && regex.password.test(req.body.old_password)) {
			password_compare(req.body.old_password, user.password, function (e, match) {
				if (e) {
					res.error(400, config.error.invalid_arguments);
				} else if (match) {
					password_create(data.password, function (e, hash) {
						if (e) {
							res.error(400, e.message || e);
						} else {
							data.password = hash;
							next();
						}
					});
				} else {
					res.error(400, config.error.invalid_arguments);
				}
			});
		} else {
			res.error(400, config.error.invalid_arguments);
		}
	}
}

/**
 * Rate limit override
 *
 * Looking at the session because the route might not be protected
 *
 * @method settings
 * @param  {Object} req      Client request
 * @param  {Object} settings settings settings (default/anon)
 * @return {Object}          Potentially modified settings settings
 */
function rate (req, settings) {
	var authenticated = ( req.session.passport !== undefined && req.session.passport.user !== undefined ),
		limit = req.server.config.rate.limit,
		seconds;

	if (authenticated && settings.limit === limit) {
		seconds = parseInt(new Date().getTime() / 1000, 10);
		settings.limit = settings.limit * config.rate.multiplier.limit;
		settings.remaining = settings.limit - ( limit - settings.remaining );
		settings.time_reset = settings.limit * config.rate.multiplier.reset;
		settings.reset = seconds + settings.time_reset;
	}

	return settings;
}

/**
 * Registration handler
 *
 * @method register
 * @param  {Object} req Client request
 * @param  {Object} res Client response
 * @return {Undefined}  undefined
 */
function register (req, res) {
	var args;

	if (req.isAuthenticated()) {
		res.error(400, config.error.already_authenticated);
	} else if (req.body !== undefined) {
		args = load("users", req.body);

		if (stores.users.indexes.email && stores.users.indexes.email[args.email] !== undefined) {
			res.error(400, config.error.email_used);
		} else if (args.firstname === undefined || args.lastname === undefined || args.email === undefined || args.password === undefined || !regex.firstname.test(args.firstname) || !regex.lastname.test(args.lastname) || !regex.email.test(args.email) || !regex.password.test(args.password)) {
			res.error(400, config.error.invalid_arguments);
		} else {
			new_user(args).then(function (arg) {
				res.respond({user_id: arg.user.key, instruction: config.instruction.verify});
				notify("email", stores.users.dump([arg.user])[0], config.template.email.verify, ( ( req.headers["x-forwarded-proto"] ? req.headers["x-forwarded-proto"] + ":" : req.parsed.protocol ) + "//" + ( req.headers["x-forwarded-protocol"] || req.parsed.host ) )).then(null, function (e) {
					log(e, "error");
				});
			}, function (e) {
				res.error(500, e.message || e);
				log(e, "error");
			});
		}
	} else {
		res.error(400, config.error.invalid_arguments);
	}
}

/**
 * User handler
 *
 * @method user
 * @param  {Object} req Client request
 * @param  {Object} res Client response
 * @return {Undefined} undefined
 */
function user (req, res) {
	var admin = req.session.admin,
		id = req.url.replace(/.*\//, ""),
		obj, output;

	if (!admin) {
		return res.error(403);
	}

	obj = stores.users.get(id);

	if (obj) {
		if (req.method == "DELETE") {
			stores.users.del(obj.key).then(function () {
				res.respond(config.instruction.success);
			}, function (e) {
				res.error(500, e.message || e);
				log(e, "error");
			});
		} else {
			output = stores.users.dump([obj])[0];
			delete output.password;
			res.respond(output);
		}
	} else {
		res.error(404);
	}
}

/**
 * Verify handler
 *
 * @method verify
 * @param  {Object} req Client request
 * @param  {Object} res Client response
 * @return {Undefined} undefined
 */
function verify (req, res) {
	var vid = req.url.replace(/.*\//, ""),
		vrec = stores.verify.get(vid),
		user = vrec ? stores.users.get(vrec.data.user_id) : null;

	if (user) {
		// Changing record shape
		user.data.verified = true;
		delete user.data.verify_id;

		// Overwriting record to remove the 'verified_id' property
		stores.users.set(user.key, user.data, false, true).then(function () {
			stores.verify.del(vid).then(null, function (e) {
				log(e, "error");
			});
			res.respond({login_uri: "/login", "instruction": "Your account has been verified, please login"});
		}, function (e) {
			res.error(500, e.message || e);
			log(e, "error");
		});
	} else {
		res.error(404);
	}
}

/**
 * Outbound webhook handler
 *
 * @method receive
 * @param  {Object} req Client request
 * @param  {Object} res Client response
 * @return {Undefined}  undefined
 */
function receive (req, res) {
	var data = clone(req.body, true),
		token = req.parsed.query[config.token] || data[config.token],
		webhook = token ? stores.webhooks.get(token) : undefined;

	if (!token || !webhook || (config.validate && webhook.data.host.indexOf(req.parsed.hostname) === -1)) {
		res.error(401);
	} else if (data === undefined || !regex.payload.test(typeof data)) {
		res.error(400);
	} else {
		res.respond("Accepted", 202);
		clientPublish.publish(config.id + "_" + webhook.data.name, serialize(data));
		sse.send({data: data, type: "inbound", webhook: webhook.data.name});
	}
}

/**
 * RegExp cache of common test patterns
 *
 * @type Object
 */
var regex = {
	email: /\w*@\w*/,
	encoding: /form|json|querystring/,
	extension: /\..*$/,
	firstname: /(\w*){1,}/,
	invite: /^\/invite/,
	lastname: /(\w*){2,}/,
	payload: /string|object/,
	password: /((?=.*\d)(?=.*[a-z])(?=.*[A-Z])(?=.*[!"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~]).{8,40})/,
	send: /_send$/,
	std_port: /^(80|443)$/,
	trailing_s: /s$/,
	trailing_slash: /\/$/,
	uri_collection: /.*\//
};

/**
 * Outbound webhook handler
 *
 * @method send
 * @param  {Object} req Client request
 * @param  {Object} res Client response
 * @param  {Object} msg Redis sourced message {channel: "", message: ""}
 * @return {Undefined}  undefined
 */
function send (req, res, desc) {
	var err = false,
		encoding = "json",
		tmp = [],
		data, token, uri, webhook;

	if (req) {
		data = req.body;
		token = data[config.token];
		delete data[config.token];
	} else {
		data = json.decode(desc.message, true) || desc.message;
		token = stores.webhooks.indexes.name[desc.channel.replace(regex.send, "").replace(config.id + "_", "")][0];
	}

	webhook = stores.webhooks.get(token);

	if (!webhook) {
		err = true;
	} else {
		uri = webhook.data.uri;

		if (!uri) {
			err = true;
		}
	}

	if (!err) {
		encoding = regex.encoding.test(webhook.data.encoding) ? webhook.data.encoding : "json";

		if (res) {
			res.respond("Accepted", 202);
		}

		if (typeof data === "string") {
			data += "&" + config.token + "=" + webhook.key;
		} else {
			data[config.token] = webhook.key;
		}

		try {
			if (encoding === "form") {
				request.post(uri).form(data).on("error", function (e) {
					log(e, "error");
				});
			} else if (encoding === "querystring") {
				if (typeof data === "object") {
					array.each(Object.keys(data), function (i) {
						tmp.push(i + "=" + encodeURIComponent(data[i]));
					});
					data = tmp.join("&");
				}

				uri += (uri.indexOf("?") > -1 ? "&" : "?") + data.replace(/^(\&|\?)/, "");
				request.get(uri).on("error", function (e) {
					log(e, "error");
				});
			} else if (encoding === "json") {
				request({body: data, method: "POST", json: true, uri: uri}).on("error", function (e) {
					log(e, "error");
				});
			}
		} catch (e) {
			log(e, "error");
		}

		sse.send({data: data, type: "outbound", webhook: webhook.data.name});
	} else {
		if (res) {
			if (webhook.data.name) {
				res.error(400, webhook.data.name + " is not configured for outbound webhooks");
			} else {
				res.error(400);
			}
		}

		log((webhook.data.name || "Unknown") + " cannot be found, or is not configured for outbound webhooks", "error");
	}
}

/**
 * Serializes `arg` if required
 *
 * @method serialize
 * @param {Mixed} arg Input argument
 * @returns {String}  JSON String
 */
function serialize (arg) {
	var result;

	if (typeof arg === "string") {
		result = arg;
	} else {
		result = JSON.stringify(arg);
	}

	return result;
}

/**
 * DataStores with persistent storage in MongoDB
 *
 * @type Object
 */
var stores = {
	webhooks: store(null, merge({id: "webhooks", index: ["user_id", "host", "name"]}, config.defaults.store)),
	users: store(null, merge({id: "users", index: ["email"]}, config.defaults.store)),
	verify: store(null, merge({id: "verify", index: ["user_id"]}, config.defaults.store))
};

/**
 * Validation functions
 *
 * @type {Object}
 */
var validation = {
	webhooks: function (arg, cb) {
		var result = !( ( typeof arg.name != "string" || arg.name === "" ) || ( typeof arg.host != "string" || arg.host === "" ) );

		if (result) {
			cb(null, true);
		} else {
			cb(new Error(config.error.invalid_arguments), null);
		}
	}
};
/**
 * API routes
 *
 * @type Object
 */
var routes = {
	"delete": {
		"/profile": profile,
		"/users/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}": user,
		"/verify/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}": function (req, res) {
			collection_item(req, res, "verify");
		},
		"/webhooks/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}": function (req, res) {
			collection_item(req, res, "webhooks");
		}
	},
	"get": {
		"/": function (req, res) {
			var session = req.session,
				headers;

			if (session && session.passport && session.passport.user) {
				headers = clone(req.server.config.headers, true);

				headers["cache-control"] = "private " + headers["cache-control"];
				res.respond(ROOT_ROUTES, 200, headers);
			} else {
				res.respond(["login", "receive", "register"]);
			}
		},
		"/admin": function (req, res) {
			var user = req.session.passport.user;

			if (array.contains(config.admin, user.email)) {
				req.session.admin = true;
				res.redirect("/");
			} else {
				res.error(403);
			}
		},
		"/profile": profile,
		"/receive": {
			"instruction": config.instruction.receive
		},
		"/register": {
			"instruction": config.instruction.register
		},
		"/send": {
			"instruction": config.instruction.send
		},
		"/stream": sse.init,
		"/users(\/?)": function (req, res) {
			if (req.session.admin) {
				res.respond(stores.users.dump().map(function (i) {
					delete i.password;
					return i;
				}));
			} else {
				res.error(403);
			}
		},
		"/users/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}": user,
		"/verify(\/?)": config.instruction.verify_endpoint,
		"/verify/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}": verify,
		"/webhooks(\/?)": function (req, res) {
			collection(req, res, "webhooks");
		},
		"/webhooks/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}": function (req, res) {
			collection_item(req, res, "webhooks");
		}
	},
	patch: {
		"/profile": profile,
		"/webhooks/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}": function (req, res) {
			collection_item(req, res, "webhooks", validation.webhooks);
		}
	},
	post: {
		"/register": register,
		"/receive": receive,
		"/send": send,
		"/webhooks(\/?)": function (req, res) {
			collection(req, res, "webhooks", validation.webhooks);
		}
	},
	put: {
		"/profile": profile,
		"/webhooks/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}": function (req, res) {
			collection_item(req, res, "webhooks", validation.webhooks);
		}
	}
};

// Initializing the application
app = init(config);

log("Rozu API " + VERSION, "debug");
} )();
