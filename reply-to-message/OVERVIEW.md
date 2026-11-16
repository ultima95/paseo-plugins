Reply to Message puts Copy and Reply on every agent reply in a conversation. Reply quotes the reply you picked into that agent's composer, so you can trim it, add your answer, and send it as a normal prompt. This is how you answer one specific point in a long reply without restating it.

The quote names the model as its first line, so the agent reading the prompt knows which agent wrote what is being answered. It uses the model rather than the agent's title because Paseo fills an agent's title with its first prompt, which is the task rather than a name.

The two buttons sit under each reply, next to its timestamp. That strip has a fixed height and is laid out on every reply, so the buttons fade in when the pointer arrives instead of pushing the reply below down, and they stay visible on touch screens and narrow windows where there is no hover to reveal them with. Reply quotes the first eight lines of the reply, or about 600 characters, and marks the rest with an ellipsis; the composer opens with the cursor below the quote. Copy copies the whole reply text.

Only agent replies are redrawn. Your own messages keep Paseo's own row, which is what lets an image attached to one of them render, and keeps the rewind menu and Paseo's own Copy on them.

Because a reply is redrawn here, one thing Paseo normally does is not available: a completed reply no longer carries its turn footer, so fork and the turn's usage line are gone, though Copy on the row still copies that reply. To get the footer back, disable the plugin.

Messages are not sent anywhere else and nothing is stored. The plugin has no backend, no account, and no settings, and it reads only the reply text Paseo already shows.

Requires Paseo 0.16.0-beta.2 or later on both the daemon and the app, because Reply uses the plugin composer API added in that version.
