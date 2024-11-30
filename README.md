# Scrypted plugins monitor

https://github.com/apocaliss92/scrypted-monitor - For requests and bugs

Scrypted plugin that can run the following actions on a scheduled base:
- Update plugins specifying beta or only release
- Restart plugins
- Diagnostics on devices and system
- Restart cameras
- Report plugin status (basically the data shown on the management plugins page)

The result of the runs can be sent on a notifier

To create a task, just go on the General tab and add a string in the Tasks selector, set a notifier as well.
On save, a new tab will appear with the task name. There the task type can be selected, and on save again the related properties will be shown