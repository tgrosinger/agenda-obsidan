import { buyMeACoffee, Element, paypal, skippedIconSvg } from './graphics';
import {
  shouldConfigureGlobalMoment,
  tryToConfigureGlobalMoment,
} from './localization';
import { ISettings, settingsWithDefaults } from './settings';
import { TaskCache } from './task-cache';
import { TaskHandler } from './task-handler';
import { TaskLine } from './task-line';
import TaskMove from './ui/TaskMove.svelte';
import TaskRepeat from './ui/TaskRepeat.svelte';
import { VaultIntermediate } from './vault';
import type { default as MomentType, WeekSpec } from 'moment';
import {
  App,
  MarkdownPostProcessorContext,
  MarkdownPreviewRenderer,
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
} from 'obsidian';
import type { IWeekStartOption } from 'obsidian-calendar-ui';

declare global {
  interface Window {
    moment: typeof MomentType;
    _bundledLocaleWeekSpec: WeekSpec;
  }
}

export default class SlatedPlugin extends Plugin {
  public settings: ISettings;

  private vault: VaultIntermediate;
  private taskHandler: TaskHandler;
  private taskCache: TaskCache;

  private lastFile: TFile | undefined;

  public async onload(): Promise<void> {
    await this.loadSettings();

    this.vault = new VaultIntermediate(this.app.vault);
    this.taskHandler = new TaskHandler(this.vault, this.settings);
    this.taskCache = new TaskCache(this.taskHandler, this.vault);

    this.app.workspace.onLayoutReady(() => {
      this.taskCache.initialize();
    });

    MarkdownPreviewRenderer.registerPostProcessor(this.renderMovedTasks);

    this.registerEvent(
      this.app.workspace.on('file-open', (file: TFile) => {
        if (!file || !file.basename) {
          return;
        }

        // This callback is fired whenever a file receives focus
        // not just when the file is first opened.
        console.debug('Slated: File opened: ' + file.basename);

        if (this.lastFile) {
          this.taskHandler.processFile(this.lastFile);
          this.taskCache.fileOpenHook(this.lastFile);
        }

        this.lastFile = file;
        this.taskHandler.processFile(file);
        this.taskCache.fileOpenHook(file);
      }),
    );

    this.addCommand({
      id: 'task-skip',
      name: 'Skip Task Occurence',
      checkCallback: (checking: boolean) => {
        if (checking) {
          return this.taskChecker();
        }

        this.withTaskLine((tl) => tl.skipOccurence());
      },
    });

    this.addCommand({
      id: 'task-move-modal',
      name: 'Move Task',
      checkCallback: (checking: boolean) => {
        if (checking) {
          return this.taskChecker();
        }

        this.withTaskLine((task: TaskLine) => {
          new TaskMoveModal(this.app, task).open();
        });
      },
    });

    this.addCommand({
      id: 'task-repeat-modal',
      name: 'Configure Task Repetition',
      checkCallback: (checking: boolean) => {
        if (checking) {
          return this.taskChecker();
        }

        this.withTaskLine((task: TaskLine) => {
          new TaskRepeatModal(this.app, task).open();
        });
      },
    });

    this.addCommand({
      id: 'move-incompleted-today',
      name: 'Move incomplete tasks from current file to today',
      checkCallback: (checking: boolean) => {
        const activeLeaf = this.app.workspace.activeLeaf;
        if (!(activeLeaf.view instanceof MarkdownView)) {
          return;
        }

        if (checking) {
          // Disallow moving tasks if currently looking at today's note
          const m = this.vault.findMomentForDailyNote(activeLeaf.view.file);
          return !(m && m.isSame(new Date(), 'day'));
        }

        this.taskHandler.moveIncompleted(
          activeLeaf.view.file,
          window.moment().startOf('day'),
        );
      },
    });

    this.addSettingTab(new SettingsTab(this.app, this));

    if (!this.settings.displayedRemoveLinksNotice) {
      const div = createDiv();
      div
        .createEl('p')
        .setText(
          'The Slated plugin has been updated to remove links between tasks.',
        );
      div
        .createEl('p')
        .setText(
          'After much reflection, it was decided that this functionality was not the right direction for Slated and caused undue complexity.',
        );
      div
        .createEl('p')
        .setText(
          'This change may result in some existing tasks not moving or repeating correctly. If you experience issues with tasks, please recreate the line without links to other notes. If you prefer the old functionality, you can restore it by manually installing the old version from https://github.com/tgrosinger/slated-obsidian/releases/tag/0.2.2',
        );
      div.createEl('p').setText('Thank you for your patience.');
      new NotificationModal(this.app, 'Slated Plugin Update Notes', div).open();
      this.settings.displayedRemoveLinksNotice = true;
      await this.saveData(this.settings);
    }
  }

  private async loadSettings(): Promise<void> {
    this.settings = settingsWithDefaults(await this.loadData());

    if (shouldConfigureGlobalMoment(this.app)) {
      tryToConfigureGlobalMoment(this.app, this.settings);
    }
  }

  private readonly taskChecker = (): boolean => {
    if (
      this.app.workspace.activeLeaf === undefined ||
      !(this.app.workspace.activeLeaf.view instanceof MarkdownView)
    ) {
      return false;
    }

    const activeLeaf = this.app.workspace.activeLeaf;
    if (!(activeLeaf.view instanceof MarkdownView)) {
      return;
    }

    const editor = activeLeaf.view.sourceMode.cmEditor;
    const currentLine = editor.getLine(editor.getCursor().line);
    return this.taskHandler.isLineTask(currentLine);
  };

  private readonly withTaskLine = async (
    fn: (task: TaskLine) => void,
  ): Promise<void> => {
    const activeLeaf = this.app.workspace.activeLeaf;
    if (!(activeLeaf.view instanceof MarkdownView)) {
      return;
    }

    const editor = activeLeaf.view.sourceMode.cmEditor;
    const cursorPos = editor.getCursor();
    const task = new TaskLine(
      cursorPos.line,
      activeLeaf.view.file,
      (await this.vault.readFile(activeLeaf.view.file, true)).split('\n'),
      this.vault,
      this.settings,
    );
    fn(task);
  };

  private readonly renderMovedTasks = (
    el: HTMLElement,
    ctx: MarkdownPostProcessorContext,
  ): Promise<any> | void => {
    // TODO: When processing before rendering is possible in the Obsidian API,
    //       switch to using TaskLine.svelte

    Object.values(el.getElementsByTagName('li'))
      .filter(
        (listItem) =>
          !listItem.hasClass('task-list-item') &&
          listItem.getText().trimStart().startsWith('[-]'),
      )
      .forEach((listItem) => {
        let innerEl: HTMLElement = listItem;
        const pElements = listItem.getElementsByTagName('p');
        if (pElements.length > 0) {
          // If there are lines in the list which do not start with a `-` then
          // the renderer will wrap everything in `p` elements. In this case
          // look at the first text node in the p element.
          innerEl = pElements[0];
        }

        let removedPrefix = '';
        for (let i = 0; i < innerEl.childNodes.length; i++) {
          const child = innerEl.childNodes[i];
          if (child.nodeType !== 3) {
            continue;
          }

          removedPrefix = child.textContent.slice(0, 4);
          child.textContent = child.textContent.slice(4);
          break; // Only perform the replacement on the first textnode in an <li>
        }

        const icon = ((): string => {
          switch (removedPrefix) {
            case '[-] ':
              return skippedIconSvg;
            default:
              console.error('Unrecognized task type: ' + removedPrefix);
              return '';
          }
        })();

        listItem.addClass('task-list-item');
        if (icon === skippedIconSvg) {
          listItem.addClass('is-skipped');
        }
        innerEl.insertBefore(Element(icon), innerEl.firstChild);
      });
  };
}

class NotificationModal extends Modal {
  private readonly title: string;
  private readonly body: HTMLElement;

  constructor(app: App, title: string, body: HTMLElement) {
    super(app);
    this.title = title;
    this.body = body;
  }

  public onOpen = (): void => {
    const { titleEl, contentEl } = this;
    titleEl.setText(this.title);
    contentEl.appendChild(this.body);
  };
}

class TaskMoveModal extends Modal {
  private readonly task: TaskLine;

  constructor(app: App, task: TaskLine) {
    super(app);
    this.task = task;
  }

  public onOpen = (): void => {
    const { contentEl } = this;
    new TaskMove({
      target: contentEl,
      props: {
        task: this.task,
        close: () => this.close(),
      },
    });
  };

  public onClose = (): void => {
    const { contentEl } = this;
    contentEl.empty();
  };
}

class TaskRepeatModal extends Modal {
  private readonly task: TaskLine;

  constructor(app: App, task: TaskLine) {
    super(app);
    this.task = task;
  }

  public onOpen = (): void => {
    const { contentEl } = this;
    new TaskRepeat({
      target: contentEl,
      props: {
        task: this.task,
        close: () => this.close(),
      },
    });
  };

  public onClose = (): void => {
    const { contentEl } = this;
    contentEl.empty();
  };
}

class SettingsTab extends PluginSettingTab {
  private readonly plugin: SlatedPlugin;

  constructor(app: App, plugin: SlatedPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  public display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl('h2', { text: 'Slated Plugin - Settings' });

    containerEl.createEl('p', {
      text: 'This plugin is in beta testing. Back up your data!',
    });
    containerEl.createEl('p', {
      text:
        'If you encounter bugs, or have feature requests, please submit them on Github.',
    });
    containerEl.createEl('p', { text: 'Thank you.' });

    new Setting(containerEl)
      .setName('Empty line after headings')
      .setDesc(
        'When creating headings or adding tasks, leave an empty line below any headings.',
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.blankLineAfterHeader)
          .onChange((value) => {
            this.plugin.settings.blankLineAfterHeader = value;
            this.plugin.saveData(this.plugin.settings);
          });
      });

    new Setting(containerEl)
      .setName('Preserve incomplete tasks once moved.')
      .setDesc(
        'After moving a task, mark as moved with [>] in current note rather than deleting it.',
      )
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.settings.preserveMovedTasks)
          .onChange((value) => {
            this.plugin.settings.preserveMovedTasks = value;
            this.plugin.saveData(this.plugin.settings);
          });
      });

    new Setting(containerEl)
      .setName('Tasks section header')
      .setDesc(
        'Markdown header to use when creating tasks section in a document',
      )
      .addText((text) => {
        text.setValue(this.plugin.settings.tasksHeader).onChange((value) => {
          if (!value.startsWith('#')) {
            new Notice('Tasks section header must start with "#"');
          }

          this.plugin.settings.tasksHeader = value;
          this.plugin.saveData(this.plugin.settings);
        });
      });

    if (shouldConfigureGlobalMoment(this.app)) {
      const sysLocale = navigator.language?.toLowerCase();

      const localizedWeekdays = window.moment.weekdays();
      const localeWeekStartNum = window._bundledLocaleWeekSpec?.dow;
      const localeWeekStart = window.moment.weekdays()[localeWeekStartNum];
      const weekdays = [
        'sunday',
        'monday',
        'tuesday',
        'wednesday',
        'thursday',
        'friday',
        'saturday',
      ];

      new Setting(this.containerEl)
        .setName('Start week on:')
        .setDesc(
          "Choose what day of the week to start. Select 'Locale default' to use the default specified by moment.js",
        )
        .addDropdown((dropdown) => {
          dropdown.addOption('locale', `Locale default (${localeWeekStart})`);
          localizedWeekdays.forEach((day, i) => {
            dropdown.addOption(weekdays[i], day);
          });
          dropdown.setValue(this.plugin.settings.weekStart);
          dropdown.onChange(async (value) => {
            this.plugin.settings.weekStart = value as IWeekStartOption;
            this.plugin.saveData(this.plugin.settings);
            tryToConfigureGlobalMoment(this.app, this.plugin.settings);
          });
        });

      new Setting(containerEl)
        .setName('Override locale:')
        .setDesc(
          'Set this if you want to use a locale different from the default',
        )
        .addDropdown((dropdown) => {
          dropdown.addOption('system-default', `Same as system (${sysLocale})`);
          window.moment.locales().forEach((locale) => {
            dropdown.addOption(locale, locale);
          });
          dropdown.setValue(this.plugin.settings.localeOverride);
          dropdown.onChange(async (value) => {
            this.plugin.settings.localeOverride = value;
            this.plugin.saveData(this.plugin.settings);
            tryToConfigureGlobalMoment(this.app, this.plugin.settings);
          });
        });
    }

    const div = containerEl.createEl('div', {
      cls: 'slated-donation',
    });

    const donateText = document.createElement('p');
    donateText.appendText(
      'If this plugin adds value for you and you would like to help support ' +
        'continued development, please use the buttons below:',
    );
    div.appendChild(donateText);

    const parser = new DOMParser();

    div.appendChild(
      createDonateButton(
        'https://paypal.me/tgrosinger',
        parser.parseFromString(paypal, 'text/xml').documentElement,
      ),
    );

    div.appendChild(
      createDonateButton(
        'https://www.buymeacoffee.com/tgrosinger',
        parser.parseFromString(buyMeACoffee, 'text/xml').documentElement,
      ),
    );
  }
}

const createDonateButton = (link: string, img: HTMLElement): HTMLElement => {
  const a = document.createElement('a');
  a.setAttribute('href', link);
  a.addClass('slated-donate-button');
  a.appendChild(img);
  return a;
};
