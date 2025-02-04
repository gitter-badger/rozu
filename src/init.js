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
