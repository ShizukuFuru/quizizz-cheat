# Quizizz-cheat

There are one methods for retrieving answers. (As i know)

1. [Fetching Cheatnetwork.eu API](#fetching-quizizz-api)

You can load this script automatically using a browser extension.
- [Using Tampermonkey](#load-automatically-using-tampermonkey)
- [Using Stay](#load-automatically-using-stay-for-safari-mac-iphone-ipad)

# Methods
## Fetching Cheatnetwork.eu (NEED A CHEATNETWORK.EU ACCOUNT)

It should work in Test and Classic mode.
1. Join Quiz
2. Open console and paste this
```ts
fetch("https://raw.githubusercontent.com/ShizukuFuru/quizizz-cheat/master/dist/bundle.js")
.then((res) => res.text()
.then((t) => eval(t)))
```
3. You can now close the console. The good answers should be highlighted by background opacity.

### Load automatically using Tampermonkey
1. Install the browser extension on **https://www.tampermonkey.net/**
2. Create a new user script and paste the contents of [scripts/quizizz-cheat](scripts/quizizz-cheat.js)
3. Using a [discord account](https://discord.com) to login to [cheatnetwork.eu](https://cheatnetwork.eu) ( MUST DO )
4. The script should now be automatically loaded every time you enter a quizizz.


### Load automatically using Stay for safari (Mac, Iphone ,Ipad)
1. Download [Stay](https://apps.apple.com/us/app/stay-for-safari/id1591620171)
2. Follow the step in the app to install it to safari
3. Click the + in the top right corner
4. Press link then paste this in " https://raw.githubusercontent.com/ShizukuFuru/quizizz-cheat/refs/heads/master/scripts/quizizz-cheat.js "


As we can see on this screenshot, the answer **www.quizizz.com** has the "(correct anwser)" next to it indicating a valid answer.
![screenshot](/screenshot_1.png)


# Credits
- [Claude](https://claude.ai)
- [ChatGPT](https://chatgpt.com)
- [Deepseek](https://chat.deepseek.com)
- leoaxo098 (For reviving this project)
- [gbaranski](https://github.com/gbaranski/quizizz-cheat) (for the original project)
