"use strict";

// Dependencies
const {
	Client,
	GatewayIntentBits,
	EmbedBuilder,
	ButtonBuilder,
	ActionRowBuilder,
	ButtonStyle,
	StringSelectMenuBuilder,
	ModalBuilder,
	TextInputBuilder,
	TextInputStyle,
	ApplicationCommandOptionType,
	Events,
	PermissionFlagsBits,
	ChannelType
} = require("discord.js");
const fs = require("fs");
const express = require("express"); // Added Express for Render HTTP binding

// ---- HTTP Health Check Server for Render ----
const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
	res.status(200).send("PvP Tierlist Bot is running!");
});

app.listen(PORT, () => {
	console.log(`HTTP Health Server listening on port ${PORT}`);
});

// Load config
// Render mounts Secret Files at /etc/secrets/<filename>, so check there first,
// then fall back to a local config.json for other environments.
const configPath = fs.existsSync("/etc/secrets/config.json")
	? "/etc/secrets/config.json"
	: "config.json";
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

const bot = new Client({
	intents: [GatewayIntentBits.Guilds]
});

// The 8 supported gamemodes. `key` must match the keys under config.gamemodes.
const GAMEMODES = [
	{ key: "crystal", label: "Crystal" },
	{ key: "sword", label: "Sword" },
	{ key: "axe", label: "Axe" },
	{ key: "nethpot", label: "Nethpot" },
	{ key: "diamondpot", label: "Diamondpot" },
	{ key: "mace", label: "Mace" },
	{ key: "uhc", label: "UHC" },
	{ key: "smp", label: "SMP" }
];
const GAMEMODE_LABELS = Object.fromEntries(GAMEMODES.map((g) => [g.key, g.label]));

function gamemodeConfig(key) {
	const gm = config.gamemodes && config.gamemodes[key];
	if (!gm) throw new Error(`Missing config.gamemodes["${key}"]`);
	return gm;
}

function gamemodeOption(name = "gamemode", required = true) {
	return {
		type: ApplicationCommandOptionType.String,
		name,
		description: "The gamemode.",
		required,
		choices: GAMEMODES.map((g) => ({ name: g.label, value: g.key }))
	};
}

function sanitizeChannelName(name) {
	return (
		name
			.toLowerCase()
			.replace(/[^a-z0-9-]/g, "-")
			.replace(/-+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 90) || "waitlist"
	);
}

// ---- State (all in-memory; resets on restart) ----

// waitlist key `${gamemode}:${userId}` -> { channelId, username, region }
const waitlist = new Map();

// queues key gamemode -> array of userIds waiting to be pulled in for that mode
const queues = new Map(GAMEMODES.map((g) => [g.key, []]));

// queueMessages key gamemode -> { message, testerId } for the currently open queue
const queueMessages = new Map();

// activeTickets key `${testerId}:${gamemode}` -> { channelId, testeeId }
const activeTickets = new Map();

// ---- UI builders ----

function buildRequestPanel() {
	const button = new ButtonBuilder()
		.setCustomId("requestTest")
		.setLabel("Request test")
		.setStyle(ButtonStyle.Primary);

	return {
		content: "Click below to request a test. You'll pick a gamemode and fill out your details.",
		components: [new ActionRowBuilder().addComponents(button)]
	};
}

function buildGamemodeSelectRow() {
	const select = new StringSelectMenuBuilder()
		.setCustomId("gamemodeSelect")
		.setPlaceholder("Choose a gamemode")
		.addOptions(GAMEMODES.map((g) => ({ label: g.label, value: g.key })));

	return new ActionRowBuilder().addComponents(select);
}

function buildTestForm(gamemodeKey) {
	const modal = new ModalBuilder()
		.setCustomId(`testForm:${gamemodeKey}`)
		.setTitle(`${GAMEMODE_LABELS[gamemodeKey]} test request`);

	const usernameInput = new TextInputBuilder()
		.setCustomId("username")
		.setLabel("Your in-game username")
		.setStyle(TextInputStyle.Short)
		.setRequired(true);

	const regionInput = new TextInputBuilder()
		.setCustomId("region")
		.setLabel("Your region (NA, EU, etc.)")
		.setStyle(TextInputStyle.Short)
		.setRequired(true);

	modal.addComponents(
		new ActionRowBuilder().addComponents(usernameInput),
		new ActionRowBuilder().addComponents(regionInput)
	);

	return modal;
}

function buildQueueEmbedAndRow(gamemodeKey) {
	const label = GAMEMODE_LABELS[gamemodeKey];
	const usersInQueue = queues.get(gamemodeKey) || [];
	const entry = queueMessages.get(gamemodeKey);

	const button = new ButtonBuilder()
		.setCustomId(`joinQueue:${gamemodeKey}`)
		.setLabel(`Join ${label} queue`)
		.setStyle(ButtonStyle.Primary);

	const row = new ActionRowBuilder().addComponents(button);

	const embed = new EmbedBuilder()
		.setTitle(`${label} tester online!`)
		.setDescription(`The queue updates every 10 seconds. You must already have the ${label} waitlist role to join (submit the request form first).

**Queue**:
${usersInQueue.map((user, index) => `${index + 1}. <@${user}>`).join("\n") || "*Nobody waiting yet.*"}

**Active tester**:
<@${entry ? entry.testerId : "unknown"}>`);

	return { embeds: [embed], components: [row] };
}

// Revokes a tester's access to their currently open ticket channel for a gamemode, without
// deleting the channel (the requester's waitlist channel persists until /result closes it out).
async function releaseActiveTicket(guild, testerId, gamemodeKey) {
	const key = `${testerId}:${gamemodeKey}`;
	const ticket = activeTickets.get(key);
	if (!ticket) return;

	activeTickets.delete(key);

	const channel = guild.channels.cache.get(ticket.channelId);
	if (channel) {
		try {
			await channel.permissionOverwrites.delete(testerId, "Ticket released.");
		} catch (err) {
			console.error("Failed to revoke tester access from channel:", err);
		}
	}
}

// ---- Main ----

bot.on(Events.ClientReady, async (readyClient) => {
	console.log(`PvP Tierlist is running as ${readyClient.user.tag}.`);

	const guild = bot.guilds.cache.first();
	if (guild) {
		await guild.commands.set([
			{
				name: "setup-request-panel",
				description: "Posts the 'Request test' button message in this channel. Run once per channel."
			},
			{
				name: "queue",
				description: "Open your queue for a gamemode (marks you online as a tester for it).",
				options: [gamemodeOption()]
			},
			{
				name: "close",
				description: "Close your queue for a gamemode (marks you offline for it).",
				options: [gamemodeOption()]
			},
			{
				name: "next",
				description: "Pull the next person in a gamemode's queue into their waitlist channel.",
				options: [gamemodeOption()]
			},
			{
				name: "remove",
				description: "Removes a user from a gamemode's live queue.",
				options: [
					gamemodeOption(),
					{
						type: ApplicationCommandOptionType.String,
						name: "user",
						description: "User to remove from the queue.",
						required: true
					}
				]
			},
			{
				name: "rank",
				description: "Set a rank to the specified user.",
				options: [
					{
						type: ApplicationCommandOptionType.String,
						name: "user",
						description: "User to give a rank.",
						required: true
					},
					{
						type: ApplicationCommandOptionType.String,
						name: "rank",
						description: "The rank to give to the user.",
						required: true
					}
				]
			},
			{
				name: "result",
				description: "Send test result. Run inside an active ticket to auto-fill details.",
				options: [
					{
						type: ApplicationCommandOptionType.String,
						name: "previous_rank",
						description: "The previous rank of the user.",
						required: true
					},
					{
						type: ApplicationCommandOptionType.String,
						name: "rank_earned",
						description: "The rank earned by the user.",
						required: true
					},
					{
						type: ApplicationCommandOptionType.User,
						name: "user",
						description: "The user who took the test. Auto-filled if run inside their ticket.",
						required: false
					},
					gamemodeOption("gamemode", false),
					{
						type: ApplicationCommandOptionType.String,
						name: "username",
						description: "Override the username on file.",
						required: false
					},
					{
						type: ApplicationCommandOptionType.String,
						name: "region",
						description: "Override the region on file.",
						required: false
					}
				]
			}
		]);
		console.log("Slash commands registered.");
	} else {
		console.error("No guilds found for the bot.");
	}

	setInterval(() => {
		for (const [gamemodeKey, entry] of queueMessages.entries()) {
			entry.message.edit(buildQueueEmbedAndRow(gamemodeKey)).catch((err) => {
				console.error(`Failed to update ${gamemodeKey} queue message:`, err);
			});
		}
	}, 10 * 1000);
});

bot.on(Events.InteractionCreate, async (interaction) => {
	try {
		if (interaction.isChatInputCommand()) {
			await handleCommand(interaction);
		} else if (interaction.isButton()) {
			await handleButton(interaction);
		} else if (interaction.isStringSelectMenu()) {
			await handleSelectMenu(interaction);
		} else if (interaction.isModalSubmit()) {
			await handleModalSubmit(interaction);
		}
	} catch (err) {
		console.error("Interaction error:", err);
		if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
			await interaction.reply({ content: "Something went wrong handling that.", ephemeral: true }).catch(() => {});
		}
	}
});

async function handleButton(interaction) {
	if (interaction.customId === "requestTest") {
		return interaction.reply({
			content: "Pick the gamemode you want to be tested for:",
			components: [buildGamemodeSelectRow()],
			ephemeral: true
		});
	}

	if (interaction.customId.startsWith("joinQueue:")) {
		const gamemodeKey = interaction.customId.split(":")[1];
		const gm = gamemodeConfig(gamemodeKey);
		const label = GAMEMODE_LABELS[gamemodeKey];

		if (!interaction.member.roles.cache.has(gm.waitlistRoleID)) {
			return interaction.reply({
				content: `You need the ${label} waitlist role first \u2014 submit the request form before joining this queue.`,
				ephemeral: true
			});
		}

		const usersInQueue = queues.get(gamemodeKey);
		if (usersInQueue.includes(interaction.user.id)) {
			return interaction.reply({ content: "You are already in this queue.", ephemeral: true });
		}

		usersInQueue.push(interaction.user.id);
		return interaction.reply({ content: `You have joined the ${label} queue.`, ephemeral: true });
	}
}

async function handleSelectMenu(interaction) {
	if (interaction.customId === "gamemodeSelect") {
		const gamemodeKey = interaction.values[0];
		return interaction.showModal(buildTestForm(gamemodeKey));
	}
}

async function handleModalSubmit(interaction) {
	if (!interaction.customId.startsWith("testForm:")) return;

	const gamemodeKey = interaction.customId.split(":")[1];
	const gm = gamemodeConfig(gamemodeKey);
	const label = GAMEMODE_LABELS[gamemodeKey];

	const username = interaction.fields.getTextInputValue("username");
	const region = interaction.fields.getTextInputValue("region");

	await interaction.deferReply({ ephemeral: true });

	const guild = interaction.guild;
	const member = interaction.member;

	await member.roles.add(gm.waitlistRoleID);

	const overwrites = [
		{ id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
		{ id: interaction.user.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] }
	];
	if (config.adminRoleID) {
		overwrites.push({ id: config.adminRoleID, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages] });
	}

	const channelOptions = {
		name: sanitizeChannelName(`waitlist-${gamemodeKey}-${username}`),
		type: ChannelType.GuildText,
		permissionOverwrites: overwrites
	};
	if (config.waitlistCategoryID) {
		channelOptions.parent = config.waitlistCategoryID;
	}

	let channel;
	try {
		channel = await guild.channels.create(channelOptions);
	} catch (err) {
		console.error("Failed to create waitlist channel:", err);
		return interaction.editReply({ content: "Could not create your waitlist channel. Please tell an admin \u2014 the bot may be missing Manage Channels permission." });
	}

	waitlist.set(`${gamemodeKey}:${interaction.user.id}`, { channelId: channel.id, username, region });

	await channel.send({
		content: `Welcome <@${interaction.user.id}>! You've requested a **${label}** test.\n\n**Username:** ${username}\n**Region:** ${region}\n\nYou now have the ${label} waitlist role. Head to the queue channel and click **Join ${label} queue** once a tester is online.`
	});

	await interaction.editReply({
		content: `You've got the ${label} waitlist role and your own channel: ${channel}. Go join the ${label} queue there once a tester is online.`
	});
}

async function handleCommand(interaction) {
	const { commandName } = interaction;

	if (commandName === "setup-request-panel") {
		if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
			return interaction.reply({ content: "You do not have the required permissions.", ephemeral: true });
		}
		await interaction.channel.send(buildRequestPanel());
		return interaction.reply({ content: "Request panel posted.", ephemeral: true });
	}

	if (commandName === "queue") {
		const gamemodeKey = interaction.options.getString("gamemode", true);
		const gm = gamemodeConfig(gamemodeKey);
		const label = GAMEMODE_LABELS[gamemodeKey];

		if (!interaction.member.roles.cache.has(gm.testerRoleID)) {
			return interaction.reply({ content: `You are not a ${label} tester.`, ephemeral: true });
		}

		const channel = interaction.guild.channels.cache.get(gm.queueChannelID);
		if (!channel) {
			return interaction.reply({ content: `${label} queue channel not found in config.`, ephemeral: true });
		}

		if (!queues.has(gamemodeKey)) queues.set(gamemodeKey, []);

		const message = await channel.send(buildQueueEmbedAndRow(gamemodeKey));
		queueMessages.set(gamemodeKey, { message, testerId: interaction.user.id });
		// Refresh now that we know the message reference.
		await message.edit(buildQueueEmbedAndRow(gamemodeKey));

		return interaction.reply({ content: `You are now online for ${label} testing.`, ephemeral: true });
	}

	if (commandName === "close") {
		const gamemodeKey = interaction.options.getString("gamemode", true);
		const gm = gamemodeConfig(gamemodeKey);
		const label = GAMEMODE_LABELS[gamemodeKey];

		if (!interaction.member.roles.cache.has(gm.testerRoleID)) {
			return interaction.reply({ content: `You are not a ${label} tester.`, ephemeral: true });
		}

		const entry = queueMessages.get(gamemodeKey);
		if (!entry || entry.testerId !== interaction.user.id) {
			return interaction.reply({ content: `You don't have an open ${label} queue.`, ephemeral: true });
		}

		await entry.message.delete().catch(() => {});
		queueMessages.delete(gamemodeKey);
		queues.set(gamemodeKey, []);

		return interaction.reply({ content: `Closed your ${label} queue.`, ephemeral: true });
	}

	if (commandName === "next") {
		const gamemodeKey = interaction.options.getString("gamemode", true);
		const gm = gamemodeConfig(gamemodeKey);
		const label = GAMEMODE_LABELS[gamemodeKey];

		if (!interaction.member.roles.cache.has(gm.testerRoleID)) {
			return interaction.reply({ content: `You are not a ${label} tester.`, ephemeral: true });
		}

		const entry = queueMessages.get(gamemodeKey);
		if (!entry || entry.testerId !== interaction.user.id) {
			return interaction.reply({ content: `Open your ${label} queue first with /queue.`, ephemeral: true });
		}

		await interaction.deferReply({ ephemeral: true });

		await releaseActiveTicket(interaction.guild, interaction.user.id, gamemodeKey);

		const usersInQueue = queues.get(gamemodeKey);
		if (!usersInQueue || usersInQueue.length === 0) {
			return interaction.editReply({ content: `The ${label} queue is empty.` });
		}

		const testeeId = usersInQueue.shift();
		const waitlistEntry = waitlist.get(`${gamemodeKey}:${testeeId}`);

		if (!waitlistEntry) {
			return interaction.editReply({ content: "That user's waitlist entry/channel could not be found (they may have left). Skipped." });
		}

		const channel = interaction.guild.channels.cache.get(waitlistEntry.channelId);
		if (!channel) {
			return interaction.editReply({ content: "Their waitlist channel no longer exists. Skipped." });
		}

		await channel.permissionOverwrites.edit(interaction.user.id, {
			ViewChannel: true,
			SendMessages: true
		});

		activeTickets.set(`${interaction.user.id}:${gamemodeKey}`, { channelId: channel.id, testeeId });

		await channel.send({ content: `<@${interaction.user.id}> is ready to test you now for **${label}**!` });

		return interaction.editReply({ content: `Pulled <@${testeeId}> in \u2014 you now have access to ${channel}.` });
	}

	if (commandName === "remove") {
		if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
			return interaction.reply({ content: "You do not have the required permissions.", ephemeral: true });
		}

		const gamemodeKey = interaction.options.getString("gamemode", true);
		let user = interaction.options.getString("user", true);
		const userIdMatch = user.match(/\d+/);

		if (!userIdMatch) {
			return interaction.reply({ content: "Invalid user ID.", ephemeral: true });
		}
		user = userIdMatch[0];

		const usersInQueue = queues.get(gamemodeKey) || [];
		if (!usersInQueue.includes(user)) {
			return interaction.reply({ content: "User is not in that queue.", ephemeral: true });
		}

		queues.set(gamemodeKey, usersInQueue.filter((u) => u !== user));
		return interaction.reply({ content: "User successfully removed from the queue.", ephemeral: true });
	}

	if (commandName === "rank") {
		if (!interaction.member.permissions.has(PermissionFlagsBits.Administrator)) {
			return interaction.reply({ content: "You do not have the required permissions.", ephemeral: true });
		}

		const userInput = interaction.options.getString("user", true);
		const rankInput = interaction.options.getString("rank", true);

		const userIdMatch = userInput.match(/\d+/);
		const rankIdMatch = rankInput.match(/\d+/);

		if (!(userIdMatch && rankIdMatch)) {
			return interaction.reply({ content: "Invalid user or role ID.", ephemeral: true });
		}

		const member = interaction.guild.members.cache.get(userIdMatch[0]);
		const role = interaction.guild.roles.cache.get(rankIdMatch[0]);

		if (!member || !role) {
			return interaction.reply({ content: "Please mention a valid user and role.", ephemeral: true });
		}

		await member.roles.add(role);
		return interaction.reply({ content: "Rank assigned successfully.", ephemeral: true });
	}

	if (commandName === "result") {
		const previousRank = interaction.options.getString("previous_rank", true);
		const rankEarned = interaction.options.getString("rank_earned", true);
		let user = interaction.options.getUser("user");
		let gamemodeKey = interaction.options.getString("gamemode");
		let username = interaction.options.getString("username");
		let region = interaction.options.getString("region");

		// Try to infer gamemode + testee from an active ticket in this channel if not given.
		if (!gamemodeKey || !user) {
			for (const [key, ticket] of activeTickets.entries()) {
				const [ticketTesterId, ticketGamemode] = key.split(":");
				if (ticketTesterId === interaction.user.id && ticket.channelId === interaction.channelId) {
					gamemodeKey = gamemodeKey || ticketGamemode;
					if (!user) {
						try {
							const member = await interaction.guild.members.fetch(ticket.testeeId);
							user = member.user;
						} catch (err) {
							// fall through, handled below
						}
					}
					break;
				}
			}
		}

		if (!gamemodeKey || !user) {
			return interaction.reply({
				content: "Could not determine the gamemode/user. Run this inside the active ticket channel, or provide the gamemode and user options.",
				ephemeral: true
			});
		}

		const label = GAMEMODE_LABELS[gamemodeKey];
		const waitlistEntry = waitlist.get(`${gamemodeKey}:${user.id}`);
		username = username || (waitlistEntry && waitlistEntry.username) || "Unknown";
		region = region || (waitlistEntry && waitlistEntry.region) || "Unknown";

		const resultsChannel = interaction.guild.channels.cache.get(config.resultsChannelID);
		if (!resultsChannel) {
			return interaction.reply({ content: "Results channel not found. Check resultsChannelID in config.json.", ephemeral: true });
		}

		const avatarUrl = `https://minotar.net/avatar/${username}`;

		const embed = new EmbedBuilder()
			.setTitle(`${user.username}'s ${label} test results 🏆`)
			.setThumbnail(avatarUrl)
			.addFields(
				{ name: "Tester", value: `<@${interaction.user.id}>`, inline: true },
				{ name: "Gamemode", value: label, inline: true },
				{ name: "Region", value: region, inline: true },
				{ name: "Username", value: username, inline: true },
				{ name: "Previous rank", value: previousRank, inline: true },
				{ name: "Rank earned", value: rankEarned, inline: true }
			);

		await resultsChannel.send({ embeds: [embed] });
		await interaction.reply({ content: `Result posted in ${resultsChannel}.`, ephemeral: true });

		// Clean up: remove waitlist role, delete their waitlist channel, clear tracking.
		const gm = gamemodeConfig(gamemodeKey);
		try {
			const member = await interaction.guild.members.fetch(user.id);
			await member.roles.remove(gm.waitlistRoleID).catch(() => {});
		} catch (err) {
			// member may have left; ignore
		}

		if (waitlistEntry) {
			const channel = interaction.guild.channels.cache.get(waitlistEntry.channelId);
			if (channel) await channel.delete("Test result submitted.").catch(() => {});
			waitlist.delete(`${gamemodeKey}:${user.id}`);
		}

		activeTickets.delete(`${interaction.user.id}:${gamemodeKey}`);
	}
}

// Token environment variable takes priority, otherwise falls back to config.json
const botToken = process.env.DISCORD_TOKEN || config.token;
bot.login(botToken);