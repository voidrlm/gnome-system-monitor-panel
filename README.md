# System Monitor Panel for GNOME

A GNOME Shell extension that shows CPU, temperature, RAM and network usage in the top bar, with a list of the heaviest apps and a button to close them. Chrome web apps (Spotify, Teams, ...) are listed under Chrome and can be closed one by one.

![Performance gauge in the top bar](screenshots/panel.png)

![CPU, temperature, GPU, RAM, network and the heaviest apps in the menu](screenshots/menu.png)

Requires GNOME Shell 50.

<details><summary>Where it sits in the top bar</summary>

![The whole top bar](screenshots/top-bar.png)

</details>

## Install

```bash
git clone https://github.com/voidrlm/gnome-system-monitor-panel.git ~/.local/share/gnome-shell/extensions/system-monitor-panel@arjun
```

Log out and back in, then enable it:

```bash
gnome-extensions enable system-monitor-panel@arjun
```

## Update

```bash
git -C ~/.local/share/gnome-shell/extensions/system-monitor-panel@arjun pull
```

Then log out and back in.
