const mineflayer = require("mineflayer");
const { pathfinder, Movements, goals } = require("mineflayer-pathfinder");
const { GoalBlock, GoalFollow, GoalNear } = goals;
const Groq = require("groq-sdk");
const vec3 = require("vec3");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const prefix = "!";

// ---------------------------------------------------------
// 1. CONFIGURATION
// ---------------------------------------------------------
const GROQ_API_KEY = "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";
const groq = new Groq({ apiKey: GROQ_API_KEY });

const bot = mineflayer.createBot({
    host: "Shifineyy.aternos.me",
    port: 46856,
    username: "Pari",
    skipValidation: true // Offline / Cracked mode
});

bot.loadPlugin(pathfinder);

let defaultMovements;
let mcData;
let trackingPlayer = null;

// Task State Controllers
let states = {
    chopping: false, clearing: false, guarding: false,
    placing: false, fishing: false, farming: false,
    mining: false, dancing: false, pvp: false
};

bot.once("spawn", () => {
    console.log(`[Bot Online] Connected as ${bot.username}! 45+ Features & Physics Engine Active.`);
    mcData = require("minecraft-data")(bot.version);
    defaultMovements = new Movements(bot, mcData);

    // FIXED JUMP & MOVEMENT PHYSICS (Prevents mid-air floating on 1-block steps)
    defaultMovements.canDig = true;
    defaultMovements.allowParkour = false; // Disabling parkour removes float bugs on basic steps
    defaultMovements.allowSprinting = true;
    defaultMovements.maxDropDown = 4;
    
    defaultMovements.scafoldingBlocks = ["dirt", "cobblestone", "stone", "oak_planks"]
        .map(name => mcData.blocksByName[name]?.id)
        .filter(id => id !== undefined);

    bot.pathfinder.setMovements(defaultMovements);

    // ANTI-STUCK WATCHDOG SYSTEM
    let lastPos = null;
    let stuckCounter = 0;
    setInterval(() => {
        if (bot.pathfinder.isMoving()) {
            const currentPos = bot.entity.position;
            if (lastPos && currentPos.distanceTo(lastPos) < 0.15) {
                stuckCounter++;
                if (stuckCounter >= 3) {
                    bot.setControlState('jump', true);
                    setTimeout(() => bot.setControlState('jump', false), 250);
                    stuckCounter = 0;
                }
            } else {
                stuckCounter = 0;
            }
            lastPos = currentPos.clone();
        }
    }, 1000);

    // HEAD TRACKING LOOP
    setInterval(() => {
        if (trackingPlayer) {
            const target = getPlayer(trackingPlayer);
            if (target) {
                bot.lookAt(target.position.offset(0, target.height * 0.85, 0));
            }
        }
    }, 100);
});

function getPlayer(username) {
    return bot.players[username]?.entity;
}

function stopAllTasks() {
    Object.keys(states).forEach(k => states[k] = false);
    trackingPlayer = null;
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    try { bot.deactivateItem(); } catch (e) {}
}

// ---------------------------------------------------------
// 2. PASSIVE AUTOMATIONS (EQUIP & EAT)
// ---------------------------------------------------------
async function equipBestEquipment() {
    const items = bot.inventory.items();
    const weaponPriority = ["netherite_sword", "diamond_sword", "iron_sword", "stone_sword", "wooden_sword", "diamond_axe"];
    
    for (const name of weaponPriority) {
        const weapon = items.find(i => i.name === name);
        if (weapon) { try { await bot.equip(weapon, "hand"); break; } catch (e) {} }
    }

    const armorSlots = {
        helmet: ["netherite_helmet", "diamond_helmet", "iron_helmet", "leather_helmet"],
        chestplate: ["netherite_chestplate", "diamond_chestplate", "iron_chestplate", "leather_chestplate"],
        leggings: ["netherite_leggings", "diamond_leggings", "iron_leggings", "leather_leggings"],
        boots: ["netherite_boots", "diamond_boots", "iron_boots", "leather_boots"]
    };

    for (const [slot, priority] of Object.entries(armorSlots)) {
        for (const name of priority) {
            const armor = items.find(i => i.name === name);
            if (armor) { try { await bot.equip(armor, slot); break; } catch (e) {} }
        }
    }
}

bot.on("health", async () => {
    if (bot.food < 15) {
        const food = bot.inventory.items().find(i => ["cooked_beef", "bread", "apple", "cooked_chicken", "golden_apple"].some(f => i.name.includes(f)));
        if (food) { try { await bot.equip(food, "hand"); await bot.consume(); } catch (e) {} }
    }
});

// ---------------------------------------------------------
// 3. CORE TASKS & FUNCTIONS
// ---------------------------------------------------------

// Auto Crafting
async function craftItem(itemName, count = 1) {
    const itemData = mcData.itemsByName[itemName.toLowerCase()];
    if (!itemData) return bot.chat(`Unknown item: ${itemName}`);

    const craftingTable = bot.findBlock({ matching: (b) => b.name === "crafting_table", maxDistance: 4 });
    const recipes = bot.recipesFor(itemData.id, null, count, craftingTable);
    
    if (!recipes || recipes.length === 0) {
        return bot.chat(`Missing materials or recipe for ${itemName}!`);
    }

    try {
        bot.chat(`Crafting ${count}x ${itemName}... 🔨`);
        await bot.craft(recipes[0], count, craftingTable);
        bot.chat(`Successfully crafted ${count}x ${itemName}!`);
    } catch (err) {
        bot.chat(`Crafting failed: ${err.message}`);
    }
}

// Radar & Block Scanner
function scanRadar() {
    const nearby = Object.values(bot.entities)
        .filter(e => e !== bot.entity && bot.entity.position.distanceTo(e.position) < 20)
        .map(e => `${e.name || e.username} (${Math.round(bot.entity.position.distanceTo(e.position))}m)`);

    if (nearby.length === 0) return bot.chat("Radar clear! No entities within 20 blocks.");
    bot.chat(`Radar (${nearby.length}): ${nearby.slice(0, 5).join(", ")}`);
}

function findNearbyBlock(blockName) {
    const block = bot.findBlock({ matching: (b) => b.name.includes(blockName.toLowerCase()), maxDistance: 32 });
    if (!block) return bot.chat(`No '${blockName}' found within 32 blocks.`);
    const p = block.position;
    bot.chat(`Found ${block.name} at X: ${p.x}, Y: ${p.y}, Z: ${p.z}!`);
}

// Combat
async function pvpPlayer(targetName) {
    const target = getPlayer(targetName);
    if (!target) return bot.chat(`I can't see ${targetName}!`);
    if (states.pvp) return;
    states.pvp = true;
    bot.chat(`Target acquired: ${targetName}. Initiating combat! ⚔️`);
    await equipBestEquipment();

    while (states.pvp && target.isValid && target.health > 0) {
        bot.pathfinder.setGoal(new GoalFollow(target, 1.5), true);
        if (bot.entity.position.distanceTo(target.position) <= 4) {
            await bot.lookAt(target.position.offset(0, target.height * 0.8, 0));
            bot.attack(target);
        }
        await sleep(500);
    }
    states.pvp = false;
    bot.chat("Combat finished.");
}

async function guardPlayer(username) {
    if (states.guarding) return;
    states.guarding = true;
    bot.chat(`Guarding ${username}! 🛡️`);
    await equipBestEquipment();
    const hostiles = ["zombie", "skeleton", "spider", "creeper", "enderman"];

    while (states.guarding) {
        await equipBestEquipment();
        const mob = bot.nearestEntity(e => (e.type === "mob" || e.type === "hostile") && hostiles.some(h => e.name?.toLowerCase().includes(h)) && bot.entity.position.distanceTo(e.position) < 16);

        if (mob) {
            while (mob.isValid && mob.health > 0 && bot.entity.position.distanceTo(mob.position) < 16 && states.guarding) {
                bot.pathfinder.setGoal(new GoalFollow(mob, 1.5), true);
                if (bot.entity.position.distanceTo(mob.position) <= 4.5) {
                    await bot.lookAt(mob.position.offset(0, mob.height * 0.8, 0));
                    bot.attack(mob);
                }
                await sleep(550);
            }
        } else {
            const owner = getPlayer(username);
            if (owner && bot.entity.position.distanceTo(owner.position) > 3) {
                bot.pathfinder.setGoal(new GoalFollow(owner, 2), true);
            }
        }
        await sleep(500);
    }
}

// Farming, Fishing, Woodcutting & Mining
async function autoFarm() {
    if (states.farming) return; states.farming = true; bot.chat("Starting farm mode! 🌾");
    while (states.farming) {
        const crop = bot.findBlock({ matching: (b) => ["wheat", "carrots", "potatoes"].includes(b.name) && b.metadata === 7, maxDistance: 15 });
        if (!crop) break;
        bot.pathfinder.setGoal(new GoalBlock(crop.position.x, crop.position.y, crop.position.z));
        await sleep(1500);
        try {
            await bot.dig(crop);
            const seedName = crop.name === "wheat" ? "wheat_seeds" : crop.name;
            const seed = bot.inventory.items().find(i => i.name === seedName);
            if (seed) { await bot.equip(seed, "hand"); await bot.placeBlock(bot.blockAt(crop.position.offset(0, -1, 0)), vec3(0, 1, 0)); }
        } catch (e) {}
        await sleep(500);
    }
    states.farming = false;
}

async function startFishing() {
    if (states.fishing) return; states.fishing = true;
    const rod = bot.inventory.items().find(i => i.name.includes("fishing_rod"));
    if (!rod) return bot.chat("I need a fishing rod!");
    await bot.equip(rod, "hand"); bot.chat("Casting my line! 🎣");
    while (states.fishing) {
        try { await bot.fish(); } catch (err) { await sleep(1000); }
        await sleep(500);
    }
}

async function mineBlockType(blockName) {
    if (states.mining) return; states.mining = true; bot.chat(`Mining ${blockName}... ⛏️`);
    while (states.mining) {
        const target = bot.findBlock({ matching: (b) => b.name.includes(blockName), maxDistance: 32 });
        if (!target) break;
        try {
            bot.pathfinder.setGoal(new GoalBlock(target.position.x, target.position.y, target.position.z));
            await sleep(2000); await bot.dig(target);
        } catch (e) {}
        await sleep(500);
    }
    states.mining = false;
}

async function chopTrees() {
    if (states.chopping) return; states.chopping = true; bot.chat("Chopping trees... 🪵");
    const logTypes = ["oak_log", "spruce_log", "birch_log", "jungle_log", "acacia_log", "dark_oak_log"];
    while (states.chopping) {
        const log = bot.findBlock({ matching: (b) => logTypes.includes(b.name), maxDistance: 20 });
        if (!log) break;
        try {
            bot.pathfinder.setGoal(new GoalBlock(log.position.x, log.position.y, log.position.z));
            await sleep(2000); await bot.dig(log);
        } catch (e) {}
        await sleep(500);
    }
    states.chopping = false;
}

// Continuous Auto-Placement (Tree Farm Replacer)
async function holdPlaceAt(itemName, targetPos) {
    if (states.placing) return; states.placing = true;
    bot.chat(`Auto-placing ${itemName}... Type !stop to cancel.`);
    const adjacentOffsets = [vec3(0, -1, 0), vec3(0, 1, 0), vec3(1, 0, 0), vec3(-1, 0, 0), vec3(0, 0, 1), vec3(0, 0, -1)];

    while (states.placing) {
        const currentBlock = bot.blockAt(targetPos);
        if (currentBlock && (currentBlock.name === "air" || currentBlock.name === "water")) {
            const item = bot.inventory.items().find((i) => i.name.toLowerCase().includes(itemName.toLowerCase()));
            if (!item) { bot.chat(`Out of ${itemName}s!`); states.placing = false; break; }

            for (const offset of adjacentOffsets) {
                const checkPos = targetPos.plus(offset);
                const b = bot.blockAt(checkPos);
                if (b && b.name !== "air" && b.name !== "water") {
                    try {
                        await bot.equip(item, "hand");
                        await bot.lookAt(b.position);
                        await bot.placeBlock(b, vec3(-offset.x, -offset.y, -offset.z));
                    } catch (err) {}
                    break;
                }
            }
        }
        await sleep(250);
    }
}

// ---------------------------------------------------------
// 4. CHAT HANDLER & ALL 45+ COMMANDS
// ---------------------------------------------------------
bot.on("chat", async (username, message) => {
    if (username === bot.username) return;
    const args = message.trim().split(" ");
    const cmd = args[0].toLowerCase();

    try {
        // AI CHAT COMMAND
        if (cmd === "!ai" || cmd === "!chat") {
            const prompt = args.slice(1).join(" ").trim();
            if (!prompt) return bot.chat("Ask me questions or give commands!");

            const chatCompletion = await groq.chat.completions.create({
                messages: [
                    { role: "system", content: "You are Pari, an intelligent Minecraft companion bot. Keep answers under 180 characters." },
                    { role: "user", content: `${username} asks: ${prompt}` }
                ],
                model: "llama-3.1-8b-instant"
            });
            const text = chatCompletion.choices[0]?.message?.content?.trim() || "No response";
            bot.chat(text.slice(0, 180));
            return;
        }

        // FULL COMMAND SWITCH
        switch (cmd) {
            // Combat & Defense
            case "!pvp": stopAllTasks(); pvpPlayer(args[1]); break;
            case "!guard": stopAllTasks(); guardPlayer(username); break;
            case "!shoot": {
                const targetS = getPlayer(args[1]);
                const bow = bot.inventory.items().find(i => i.name.includes("bow"));
                if (targetS && bow) {
                    await bot.equip(bow, "hand");
                    await bot.lookAt(targetS.position.offset(0, targetS.height, 0));
                    bot.activateItem(); await sleep(1200); bot.deactivateItem();
                } else bot.chat("Need target and bow!");
                break;
            }
            case "!shield": {
                const shield = bot.inventory.items().find(i => i.name === "shield");
                if (shield) { await bot.equip(shield, "off-hand"); bot.chat("Equipped shield!"); }
                break;
            }
            case "!totem": {
                const totem = bot.inventory.items().find(i => i.name === "totem_of_undying");
                if (totem) { await bot.equip(totem, "off-hand"); bot.chat("Equipped totem!"); }
                break;
            }

            // Mining, Gathering & Crafting
            case "!craft": craftItem(args[1], parseInt(args[2] || 1)); break;
            case "!smelt": {
                const furnaceBlock = bot.findBlock({ matching: b => b.name === "furnace", maxDistance: 4 });
                if (!furnaceBlock) return bot.chat("No furnace nearby!");
                const rawItem = bot.inventory.items().find(i => i.name.includes(args[1] || "raw"));
                const fuelItem = bot.inventory.items().find(i => i.name.includes("coal") || i.name.includes("planks"));
                if (rawItem && fuelItem) {
                    const furnace = await bot.openFurnace(furnaceBlock);
                    await furnace.putFuel(fuelItem.type, null, fuelItem.count);
                    await furnace.putInput(rawItem.type, null, rawItem.count);
                    bot.chat(`Smelting ${rawItem.name}!`); furnace.close();
                } else bot.chat("Need fuel and raw ores!");
                break;
            }
            case "!mine": stopAllTasks(); mineBlockType(args[1] || "stone"); break;
            case "!chop": stopAllTasks(); chopTrees(); break;
            case "!farm": stopAllTasks(); autoFarm(); break;
            case "!fish": stopAllTasks(); startFishing(); break;

            // Chest Storage & Items
            case "!deposit": {
                const chestBlock = bot.findBlock({ matching: b => b.name.includes("chest") || b.name.includes("barrel"), maxDistance: 4 });
                if (!chestBlock) return bot.chat("No chest nearby!");
                try {
                    const container = await bot.openContainer(chestBlock);
                    for (const item of bot.inventory.items()) {
                        if (!item.name.includes("sword") && !item.name.includes("pickaxe")) {
                            await container.deposit(item.type, null, item.count); await sleep(100);
                        }
                    }
                    container.close(); bot.chat("Deposited extra items!");
                } catch (e) { bot.chat("Chest error!"); }
                break;
            }
            case "!withdraw": {
                const chestBlock = bot.findBlock({ matching: b => b.name.includes("chest") || b.name.includes("barrel"), maxDistance: 4 });
                if (!chestBlock) return bot.chat("No chest nearby!");
                try {
                    const container = await bot.openContainer(chestBlock);
                    const itemData = mcData.itemsByName[args[1]?.toLowerCase()];
                    if (itemData) { await container.withdraw(itemData.id, null, parseInt(args[2] || 64)); bot.chat(`Withdrew ${args[1]}!`); }
                    container.close();
                } catch (e) { bot.chat("Could not withdraw!"); }
                break;
            }
            case "!inv": {
                const items = bot.inventory.items().map(i => `${i.count}x ${i.name}`).slice(0, 6).join(", ");
                bot.chat(items ? `Inventory: ${items}` : "Inventory empty!");
                break;
            }
            case "!equip": {
                const eq = bot.inventory.items().find(i => i.name.includes(args[1]?.toLowerCase()));
                if (eq) { await bot.equip(eq, "hand"); bot.chat(`Equipped ${eq.name}!`); }
                break;
            }
            case "!drop": {
                const dr = bot.inventory.items().find(i => i.name.includes(args[1]?.toLowerCase()));
                if (dr) { await bot.tossStack(dr); bot.chat(`Dropped ${dr.name}`); }
                break;
            }
            case "!dropall": {
                for (const item of bot.inventory.items()) { await bot.tossStack(item); await sleep(100); }
                bot.chat("Dropped everything!");
                break;
            }
            case "!toss": {
                const p = getPlayer(args[1] || username);
                if (p) {
                    bot.pathfinder.setGoal(new GoalNear(p.position.x, p.position.y, p.position.z, 2));
                    await sleep(2000);
                    for (const item of bot.inventory.items()) await bot.tossStack(item);
                }
                break;
            }

            // Radar & Info
            case "!radar": scanRadar(); break;
            case "!find": if (args[1]) findNearbyBlock(args[1]); break;
            case "!inspect": {
                const block = bot.blockAtCursor(5);
                bot.chat(block ? `Looking at: ${block.name}` : "Not looking at any block.");
                break;
            }
            case "!time": bot.chat(`Time: ${bot.time.timeOfDay} ticks (${bot.time.isDay ? "Day ☀️" : "Night 🌙"})`); break;
            case "!weather": bot.chat(bot.isRaining ? "Raining 🌧️" : "Clear ☀️"); break;
            case "!biome": {
                const bId = bot.world.getBiome(bot.entity.position);
                bot.chat(`Biome: ${mcData.biomes[bId]?.name || "Unknown"}`);
                break;
            }
            case "!pos": bot.chat(`X: ${Math.floor(bot.entity.position.x)}, Y: ${Math.floor(bot.entity.position.y)}, Z: ${Math.floor(bot.entity.position.z)}`); break;
            case "!health": bot.chat(`HP: ${Math.round(bot.health)}/20 | Food: ${Math.round(bot.food)}/20`); break;
            case "!xp": bot.chat(`XP Level: ${bot.experience.level} (${bot.experience.points} pts)`); break;
            case "!players": bot.chat(`Online: ${Object.keys(bot.players).join(", ")}`); break;

            // Building & Blocks
            case "!holdplace":
                if (args.length === 5) {
                    stopAllTasks();
                    holdPlaceAt(args[1], vec3(parseInt(args[2]), parseInt(args[3]), parseInt(args[4])));
                }
                break;
            case "!buildwall": {
                const blockItem = bot.inventory.items().find(i => ["dirt", "cobblestone", "stone"].some(b => i.name.includes(b)));
                if (blockItem) {
                    await bot.equip(blockItem, "hand");
                    const startPos = bot.entity.position.floored().offset(2, 0, 0);
                    for (let y = 0; y < (parseInt(args[2]) || 3); y++) {
                        for (let x = 0; x < (parseInt(args[1]) || 3); x++) {
                            const refBlock = bot.blockAt(startPos.offset(x, y - 1, 0));
                            if (refBlock && refBlock.name !== "air") {
                                try { await bot.placeBlock(refBlock, vec3(0, 1, 0)); await sleep(250); } catch (e) {}
                            }
                        }
                    }
                }
                break;
            }

            // Movement, Rest & Vehicles
            case "!follow": stopAllTasks(); bot.pathfinder.setGoal(new GoalFollow(getPlayer(args[1] || username), 2), true); break;
            case "!goto": stopAllTasks(); bot.pathfinder.setGoal(new GoalBlock(parseInt(args[1]), parseInt(args[2]), parseInt(args[3]))); break;
            case "!track": trackingPlayer = trackingPlayer === (args[1] || username) ? null : (args[1] || username); break;
            case "!sneak": bot.setControlState('sneak', true); break;
            case "!unsneak": bot.setControlState('sneak', false); break;
            case "!stuck": bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 400); break;
            case "!mount": {
                const v = bot.nearestEntity(e => e.name === "boat" || e.name === "minecart" || e.name === "horse");
                if (v) await bot.mount(v); else bot.chat("No vehicle nearby!");
                break;
            }
            case "!dismount": bot.dismount(); break;
            case "!sleep": {
                const bed = bot.findBlock({ matching: b => b.name.includes("bed"), maxDistance: 10 });
                if (bed) await bot.sleep(bed); else bot.chat("No bed nearby!");
                break;
            }
            case "!wake": await bot.wake(); bot.chat("Woke up!"); break;

            // Emotes & Fun
            case "!eat": {
                const food = bot.inventory.items().find(i => ["apple", "beef", "bread"].some(f => i.name.includes(f)));
                if (food) { await bot.equip(food, "hand"); await bot.consume(); }
                break;
            }
            case "!jump": bot.setControlState('jump', true); setTimeout(() => bot.setControlState('jump', false), 250); break;
            case "!spin": {
                for (let i = 0; i < 8; i++) { bot.look(bot.entity.yaw + 0.8, bot.entity.pitch); await sleep(100); }
                break;
            }
            case "!dance":
                stopAllTasks(); states.dancing = true;
                while (states.dancing) {
                    bot.setControlState('sneak', true); await sleep(200); bot.setControlState('sneak', false);
                    bot.setControlState('jump', true); await sleep(200); bot.setControlState('jump', false);
                    bot.look(bot.entity.yaw + 1.5, bot.entity.pitch); await sleep(200);
                }
                break;
            case "!say": bot.chat(args.slice(1).join(" ")); break;

            // Control & Help
            case "!stop": stopAllTasks(); bot.chat("Stopped all actions."); break;
            case "!help": bot.chat("Commands: !ai, !pvp, !guard, !craft, !smelt, !deposit, !withdraw, !mine, !chop, !farm, !fish, !radar, !follow, !goto, !stop"); break;
        }
    } catch (err) {
        console.error("[Bot Error]:", err.message);
    }
});

bot.on("login", () => console.log("[Bot] Successfully logged into server!"));
bot.on("kicked", (reason) => console.log("[Kicked Reason]:", JSON.stringify(reason)));
bot.on("error", (err) => console.log("[Connection Error]:", err.message));
bot.on("end", (reason) => console.log("[Bot Disconnected]:", reason));
