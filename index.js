/* eslint-disable no-param-reassign */

module.exports = function boxOpener(dispatch) {
	const command = dispatch.command || dispatch.require.command;

	const BOSS_PET_FIRST_ID = 960500;
	const BOSS_PET_LAST_ID = 960537;
	const BOSS_PET_RESPONSE_TIMEOUT = 5500;
	const BOSS_PET_CONTRACT_TIMEOUT = 3000;

	let hooks = [],
		enabled = false,
		boxEvent = null,
		gacha_detected = false,
		gacha_contract = 0,
		isLooting = false,
		location = null,
		timer = null,
		delay = 5500,
		useDelay = false,
		statOpened = 0,
		statUsed = 0,
		statStarted = null,
		scanning = false,
		bossPetMode = false,
		bossPetPending = null,
		bossPetContract = 0,
		bossPetContractItemId = 0,
		bossPetState = "idle",
		bossPetWaitingForLocation = false;

	command.add("box", (...args) => {
		if (args.join(" ").trim().toLowerCase() === "boss") {
			toggleBossPet();
			return;
		}
		if (!enabled && !scanning) {
			scanning = true;
			load();
			command.message("Please normally open a box now and the script will continue opening it");
		} else {
			stop();
		}
	});

	command.add("boxdelay", (arg) => {
		if (arg === "0") {
			useDelay = false;
			delay = 5500;
			command.message("Turning OFF minimum box opening delay, enjoy the speed");
		} else if (!isNaN(arg)) {
			useDelay = true;
			delay = parseInt(arg);
			command.message(`Minimum box opening delay is set to: ${delay / 1000} sec`);
		} else {
			command.message(`Minimum box opening delay is set to: ${useDelay ? `${delay / 1000} sec` : "no delay"}`);
		}
	});

	dispatch.hook("C_PLAYER_LOCATION", 5, event => {
		location = event;
		if (bossPetMode && bossPetWaitingForLocation) {
			bossPetWaitingForLocation = false;
			openNextBossPet();
		}
	});

	dispatch.game.initialize("inventory");

	dispatch.game.inventory.on("update", () => {
		if (!enabled) return;

		isLooting = false;
		if (bossPetMode) checkBossPetProgress();
	});

	function load() {
		hook("C_USE_ITEM", 3, event => {
			if (gacha_detected) return false;
			if (!scanning) return;

			if (scanning) {
				boxEvent = event;
				boxEvent.dbid = 0n; // to open all inv slots
				command.message(`Box set to: ${event.id}, proceeding to auto-open it with ${useDelay ? `a minimum ${delay / 1000} sec delay` : "no delay"}`);
				scanning = false;

				const d = new Date();
				statStarted = d.getTime();
				enabled = true;
				timer = dispatch.setTimeout(openBox, delay);
			}
		});

		hook("S_SYSTEM_MESSAGE_LOOT_ITEM", "raw", () => {
			if (bossPetMode) return;
			if (!gacha_detected && !isLooting && boxEvent) {
				isLooting = true;
				if (!useDelay) {
					dispatch.clearTimeout(timer);
					openBox();
				}
			}
		});

		hook("S_GACHA_START", "raw", () => {
			if (!bossPetMode || !bossPetPending || bossPetState !== "waiting-start") return;
			tryBossPetGacha();
			return false; // Hide the gacha dialog.
		});

		hook("S_GACHA_END", "raw", () => {
			if (bossPetMode && bossPetPending && (bossPetState === "rolling" || bossPetState === "waiting-inventory")) {
				bossPetPending.gachaEnded = true;
				bossPetState = "waiting-inventory";
				checkBossPetProgress();
				return false;
			}
			if (boxEvent && gacha_detected) {
				dispatch.clearTimeout(timer);
				if (useDelay) timer = dispatch.setTimeout(openBox, delay);
				else process.nextTick(openBox);
			}
		});

		hook("S_SYSTEM_MESSAGE", 1, event => {
			const msg = dispatch.parseSystemMessage(event.message).id;
			if (bossPetMode && msg === "SMT_GACHA_CANCEL") return;
			if (["SMT_ITEM_MIX_NEED_METERIAL", "SMT_CANT_CONVERT_NOW", "SMT_GACHA_NO_MORE_ITEM_SHORT", "SMT_NOTI_LEFT_LIMITED_GACHA_ITEM", "SMT_GACHA_CANCEL", "SMT_COMMON_NO_MORE_ITEM_TO_USE"].includes(msg)) {
				command.message("Box can not be opened anymore, stopping");
				stop();
			}
		});

		if (dispatch.majorPatchVersion >= 93) {
			hook("S_REQUEST_CONTRACT", dispatch.majorPatchVersion > 107 ? 2 : 1, event => {
				if (bossPetMode) {
					if (event.type === 53 && bossPetPending && bossPetState === "waiting-contract") {
						bossPetContract = event.id;
						bossPetContractItemId = bossPetPending.id;
						bossPetState = "waiting-start";
						armBossPetTimeout(BOSS_PET_CONTRACT_TIMEOUT, "Gacha start was not received");
						return false;
					}
					return;
				}
				if (event.type !== 53) return;
				dispatch.hookOnce("S_GACHA_START", "raw", () => {
					gacha_detected = true;
					gacha_contract = event.id;
					openBox();
					return false;
				});
				return false;
			});

			hook("S_CANCEL_CONTRACT", 1, event => {
				if (bossPetMode && event.type === 53 && bossPetContract) {
					bossPetContract = 0;
					bossPetContractItemId = 0;
					if (bossPetState === "closing") {
						dispatch.clearTimeout(timer);
						timer = null;
						bossPetState = "idle";
						openNextBossPet();
					} else if (bossPetState === "waiting-start") {
						command.message("Gacha contract ended before the boss pet box could be opened.");
						stopBossPet();
					}
					return;
				}
				if (!gacha_detected || event.type !== 53) return;
				gacha_contract = 0;
				stop();
			});
		} else {
			hook("S_GACHA_START", 1, event => {
				gacha_detected = true;
				dispatch.send("C_GACHA_TRY", 1, {
					"id": event.id
				});
			});
		}
	}

	function openBox() {
		if (dispatch.game.inventory.getTotalAmount(boxEvent.id) > 0) {
			if (dispatch.majorPatchVersion >= 93) {
				if (gacha_detected) {
					if (dispatch.majorPatchVersion >= 99) {
						dispatch.toServer("C_GACHA_TRY", 2, {
							id: gacha_contract,
							amount: 1
						});
					} else {
						dispatch.toServer("C_GACHA_TRY", 1, {
							id: gacha_contract
						});
					}
				} else {
					boxEvent.loc = location.loc;
					boxEvent.w = location.w;
					dispatch.toServer("C_USE_ITEM", 3, boxEvent);
					if (useDelay) {
						statUsed++;	// counter for used items other than boxes
					}
					timer = dispatch.setTimeout(openBox, delay);
				}
			} else {
				boxEvent.loc = location.loc;
				boxEvent.w = location.w;
				dispatch.send("C_USE_ITEM", 3, boxEvent);
				if (useDelay) {
					statUsed++;	// counter for used items other than boxes
				}
			}
			statOpened++;
		} else {
			command.message("You ran out of boxes, stopping");
			stop();
		}
	}

	// Open every boss pet box ID (960500 through 960537) without changing normal !box behavior.
	function toggleBossPet() {
		if (bossPetMode) return stopBossPet();
		if (enabled || scanning) {
			command.message("Another box-opening session is active. Use !box to stop it first.");
			return;
		}
		if (dispatch.majorPatchVersion < 93) {
			command.message("Boss pet mode requires a TERA patch that supports gacha contracts.");
			return;
		}
		if (!dispatch.game.me.gameId) {
			command.message("You must be logged into a character to open boss pet boxes.");
			return;
		}
		if (!findNextBossPet()) {
			command.message("No boss pet boxes (960500-960537) found in your inventory.");
			return;
		}

		bossPetMode = true;
		enabled = true;
		bossPetPending = null;
		bossPetContract = 0;
		bossPetContractItemId = 0;
		bossPetState = "idle";
		statOpened = 0;
		statStarted = Date.now();
		load();
		command.message("Boss pet opener started (960500-960537). Use !box boss again to stop.");
		if (!location || !location.loc) {
			bossPetWaitingForLocation = true;
			command.message("Move your character slightly so Toolbox can read your position.");
			return;
		}
		openNextBossPet();
	}

	function findNextBossPet() {
		for (let id = BOSS_PET_FIRST_ID; id <= BOSS_PET_LAST_ID; id++) {
			const item = dispatch.game.inventory.findInBagOrPockets(id);
			if (item && item.amount > 0) return item;
		}
		return null;
	}

	function armBossPetTimeout(ms, reason) {
		dispatch.clearTimeout(timer);
		timer = dispatch.setTimeout(() => {
			if (!bossPetMode) return;
			const id = bossPetPending ? bossPetPending.id : "unknown";
			command.message(`Boss pet box ${id}: ${reason}. Stopping to avoid spamming.`);
			stopBossPet();
		}, ms);
	}

	function openNextBossPet() {
		if (!bossPetMode || !enabled || bossPetPending || bossPetState === "closing") return;
		if (!location || !location.loc) {
			bossPetWaitingForLocation = true;
			return;
		}
		const item = findNextBossPet();
		if (!item) {
			command.message("All boss pet boxes in your inventory have been opened.");
			stopBossPet();
			return;
		}

		// Cancel a contract only when switching to a different boss pet box ID.
		if (bossPetContract && bossPetContractItemId !== item.id) {
			bossPetState = "closing";
			armBossPetTimeout(BOSS_PET_CONTRACT_TIMEOUT, "Previous gacha contract did not close");
			dispatch.toServer("C_GACHA_CANCEL", 1, { id: bossPetContract });
			return;
		}

		bossPetPending = {
			id: item.id,
			amountBefore: dispatch.game.inventory.getTotalAmountInBagOrPockets(item.id),
			gachaEnded: false
		};
		if (bossPetContract) return tryBossPetGacha(); // Reuse the contract for this ID.

		bossPetState = "waiting-contract";
		armBossPetTimeout(BOSS_PET_RESPONSE_TIMEOUT, "No gacha contract received (the box may use a different dialog type)");
		dispatch.toServer("C_USE_ITEM", 3, {
			gameId: dispatch.game.me.gameId,
			id: item.id,
			dbid: 0n,
			target: 0n,
			amount: 1,
			dest: location.loc,
			loc: location.loc,
			w: location.w,
			unk1: 0,
			unk2: 0,
			unk3: 0,
			unk4: true
		});
	}

	function tryBossPetGacha() {
		if (!bossPetMode || !bossPetPending || !bossPetContract) return;
		bossPetState = "rolling";
		armBossPetTimeout(BOSS_PET_RESPONSE_TIMEOUT, "Gacha result/inventory update not received");
		if (dispatch.majorPatchVersion >= 99) {
			dispatch.toServer("C_GACHA_TRY", 2, { id: bossPetContract, amount: 1 });
		} else {
			dispatch.toServer("C_GACHA_TRY", 1, { id: bossPetContract });
		}
	}

	function checkBossPetProgress() {
		if (!bossPetMode || !bossPetPending) return;
		if (bossPetState !== "rolling" && bossPetState !== "waiting-inventory") return;
		const remaining = dispatch.game.inventory.getTotalAmountInBagOrPockets(bossPetPending.id);
		if (remaining >= bossPetPending.amountBefore || !bossPetPending.gachaEnded) return;
		statOpened++;
		bossPetPending = null;
		bossPetState = "idle";
		dispatch.clearTimeout(timer);
		timer = dispatch.setTimeout(openNextBossPet, useDelay ? delay : 125);
	}

	function stopBossPet() {
		if (!bossPetMode) return;
		dispatch.clearTimeout(timer);
		unload();
		if (bossPetContract) dispatch.toServer("C_GACHA_CANCEL", 1, { id: bossPetContract });
		bossPetMode = false;
		bossPetPending = null;
		bossPetContract = 0;
		bossPetContractItemId = 0;
		bossPetState = "idle";
		bossPetWaitingForLocation = false;
		enabled = false;
		const seconds = ((Date.now() - statStarted) / 1000).toFixed(1);
		command.message(`Boss pet opener stopped. Confirmed opened: ${statOpened} box(es) in ${seconds} sec.`);
		statOpened = 0;
		statStarted = null;
		timer = null;
	}

	function addZero(i) {
		if (i < 10) {
			i = `0${i}`;
		}
		return i;
	}

	function stop() {
		if (bossPetMode) return stopBossPet();
		unload();
		if (scanning) {
			scanning = false;
			command.message("Scanning for a box is aborted");
		} else {
			if (gacha_detected && gacha_contract) dispatch.toServer("C_GACHA_CANCEL", 1, { id: gacha_contract });
			if (useDelay && statOpened === 0) statOpened = statUsed;
			if (!gacha_detected) statOpened += 1; // Add the box we used at start if not gacha.
			dispatch.clearTimeout(timer);
			enabled = false;
			gacha_detected = false;
			gacha_contract = 0;
			boxEvent = null;
			let d = new Date();
			const t = d.getTime();
			const timeElapsedMSec = t - statStarted;
			d = new Date(1970, 0, 1); // Epoch
			d.setMilliseconds(timeElapsedMSec);
			const h = addZero(d.getHours());
			const m = addZero(d.getMinutes());
			const s = addZero(d.getSeconds());
			command.message(`Box opener stopped. Opened: ${statOpened} boxes. Time elapsed: ${h}:${m}:${s}. Per box: ${((timeElapsedMSec / statOpened) / 1000).toPrecision(2)} sec`);
			statOpened = 0;
			statUsed = 0;
		}
	}

	function unload() {
		if (hooks.length) {
			for (const h of hooks) dispatch.unhook(h);

			hooks = [];
		}
	}

	function hook() {
		hooks.push(dispatch.hook(...arguments));
	}
};
