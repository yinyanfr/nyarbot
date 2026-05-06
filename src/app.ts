import "dotenv/config";

/**
 * this is the backend for a personal ai chat bot using in a single groupchat
 * since it is designed for a single group, we only consider the usage in the given group
 * meaning that it will ignore all messages in private chats and other groups if it was added into
 * the final goal is to make this bot reply and send messages as natually as a real person
 * so that these are key features:
 * 1. the bot will memorize every user in the groupchat, storing their uid, nicknames, and memories in firebase
 * 2. the bot will memorize chat histories, understand images and stickers, and send stickers when appropriate
 * 3. the bot will not only reply messages when it is pinged or replyed, but will alse proactively participate the chat
 * meaning that it will decide when to send its messages according to the discussion frequency of the group
 * 4. and some misc features will be added in such as greeting nighty night (to be precised)
 *
 * let's do this step by step like real software engineering, and i am the product manager
 * after repo init, we'll discuss the architechture, tech choices, and progress board
 * good luck my ai dev friend
 */
