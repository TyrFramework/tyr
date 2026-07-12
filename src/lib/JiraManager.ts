/**
 * @fileoverview One of the Managers instantiated once by {@link Container} and exposed on every
 * {@link TyrContext} as `context.jira`. Built on top of {@link WebManager} (Jira REST calls) and
 * {@link ShellManager} (interactive prompts); degrades gracefully to a manual branch-name prompt
 * whenever `JIRA_URL`/`JIRA_TOKEN` aren't configured or the API call fails, so a workspace-setup
 * command using this Manager never hard-fails just because Jira isn't set up.
 */
import { WebManager } from './WebManager.js';
import { ShellManager } from './ShellManager.js';
import { Logger } from '../core/Logger.js';

import {getEnvString} from '../core/util/getenv.js';


interface JiraIssue {
    key: string;
    summary: string;
    status: string;
}

/**
 * @class JiraManager
 * @description Integration with the Jira REST API. Allows fetching and selecting issues
 * assigned to the current user. Falls back to manual branch input if Jira is unavailable.
 *
 * Required environment variables:
 *   JIRA_URL   – e.g. https://yourcompany.atlassian.net
 *   JIRA_TOKEN – base64 of "email:api_token" (Basic Auth)
 */
export class JiraManager {
    private web: WebManager;
    private shell: ShellManager;
    private logger: Logger;

    constructor(web: WebManager, shell: ShellManager, logger: Logger) {
        this.web = web;
        this.shell = shell;
        this.logger = logger;
    }

    private get jiraUrl(): string | undefined {
        return getEnvString('JIRA_URL');
    }

    private get jiraToken(): string | undefined {
        return getEnvString('JIRA_TOKEN');
    }

    /** Returns `[]` (rather than throwing) whenever Jira isn't configured, so callers such as
     *  `selectIssue()` can treat "not configured" and "no issues assigned" uniformly. */
    private async fetchMyIssues(): Promise<JiraIssue[]> {
        if (!this.jiraUrl || !this.jiraToken) return [];

        const jql = 'assignee = currentUser() AND status IN ("To develop","TO BE DONE",Backlog,"Pending Info",Developing,DEVELOPMENT,"In development",TEST,DESIGN,"To Do","In Progress")';
        const url = `${this.jiraUrl}/rest/api/3/search?jql=${encodeURIComponent(jql)}`;

        const data = await this.web.get(url, {
            headers: { Authorization: `Basic ${this.jiraToken}` },
        });

        return (data.issues ?? []).map((issue: any) => ({
            key: issue.key,
            summary: issue.fields.summary,
            status: issue.fields.status.name,
        }));
    }

    /**
     * @method selectIssue
     * @description Presents the user's open Jira issues as an interactive list and returns
     * the selected issue key (e.g. "PROJ-123"). If Jira is not configured or unreachable,
     * falls back to a free-text prompt for a branch name.
     * Returns null if the user chooses to skip.
     * @returns {Promise<string | null>} The selected Jira key, a branch name, or null.
     * @example
     * const branch = await jira.selectIssue();
     * if (branch) await workspace.tagWorkspace(dir, branch);
     */
    public async selectIssue(): Promise<string | null> {
        // Try Jira API
        if (this.jiraUrl && this.jiraToken) {
            try {
                const issues = await this.fetchMyIssues();
                const choices = [
                    ...issues.map(i => ({
                        name: `${i.key} - ${i.summary} [${i.status}]`,
                        value: i.key,
                    })),
                    { name: 'No ticket (enter branch manually)', value: '__manual__' },
                    { name: 'Skip (do not create branch)', value: '__skip__' },
                ];

                const selected = await this.shell.select(choices, 'Select a Jira ticket:');

                if (selected === '__skip__') return null;
                if (selected === '__manual__') return this.askForBranch();

                return selected;
            } catch {
                this.logger.warn('Could not connect to Jira. Manual branch entry.');
            }
        }

        return this.askForBranch();
    }

    private async askForBranch(): Promise<string | null> {
        const raw = await this.shell.input('Enter the new branch name (empty to skip):');
        if (!raw.trim()) return null;
        // Normalise: take the last segment separated by '/'
        return raw.trim().split('/').pop()?.toUpperCase() ?? raw.trim();
    }
}

export const JiraManagerTests = {};
