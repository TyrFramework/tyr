/**
 * @fileoverview One of the Managers instantiated once by {@link Container} and exposed on every
 * {@link TyrContext} as `context.web`. HTTP requests and lightweight HTML scraping (via axios +
 * cheerio). Also used internally by other Managers that need to fetch remote content over HTTPS —
 * `JiraManager` (REST calls) and `sys/modules.ts`'s `fetchManifest()`/module sync (downloading
 * manifests and `.tyr.ts` command files) both go through an injected `WebManager` rather than
 * calling axios themselves.
 */
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import * as cheerio from 'cheerio';

import { Logger } from '../core/Logger.js';
import { TyrError } from '../core/TyrError.js';

/**
 * @class WebManager
 * @description Utilities for accessing APIs and the Internet.
 */
export class WebManager {
    private logger: Logger;

    constructor(logger: Logger) {
        this.logger = logger;
    }

    private async fetch(url: string, config?: AxiosRequestConfig): Promise<cheerio.CheerioAPI> {
        try {
            const response: AxiosResponse<string> = await axios.get(url, config);
            return cheerio.load(response.data);
        } catch (e) {
            throw new TyrError(`Could not fetch URL: ${url}`, e, 'Check your internet connection and that the URL is valid.');
        }
    }

    /**
     * @method get
     * @description Makes an HTTP GET request and returns the raw response data. Useful for REST APIs.
     * @param {string} url - The URL to request.
     * @param {AxiosRequestConfig} config - Optional Axios config (headers, params, etc.).
     * @returns {Promise<any>} The response data.
     * @example
     * const data = await web.get('https://api.example.com/items', { headers: { Authorization: 'Bearer token' } });
     */
    public async get(url: string, config?: AxiosRequestConfig): Promise<any> {
        try {
            const response = await axios.get(url, config);
            return response.data;
        } catch (e: any) {
            const status = e?.response?.status;
            const err = new TyrError(`HTTP GET failed (${status ?? 'unknown'}): ${url}`, e, 'Check your network connection and the URL.');
            (err as any).status = status;
            throw err;
        }
    }

    /**
     * @method getMetaTag
     * @description Fetches a page and returns the content of a specific meta tag.
     * @param {string} url - The URL of the page to scrape.
     * @param {string} metaName - The name attribute of the meta tag.
     * @returns {Promise<string|null>} The content of the meta tag, or null if not found.
     * @example
     * const webname = await web.getMetaTag('https://client.example.com', 'webname');
     */
    public async getMetaTag(url: string, metaName: string): Promise<string | null> {
        try {
            const $ = await this.fetch(url);
            return $(`meta[name="${metaName}"]`).attr('content') ?? null;
        } catch (e) {
            if (e instanceof TyrError) throw e;
            throw new TyrError(`Could not read meta tag '${metaName}' from: ${url}`, e);
        }
    }

    /**
     * @method selectFromWeb
     * @description Selects elements from a web page using a CSS selector.
     * @param {string} url - URL of the page to scrape.
     * @param {Function} selector - CSS selector function.
     * @returns {Promise<string[]>} List of extracted text values.
     * @example
     * const titles = await web.selectFromWeb('https://example.com', ($) => $('h1'));
     */
    public async selectFromWeb(url: string, selector: ($: cheerio.CheerioAPI) => cheerio.Cheerio<any>): Promise<string[]> {
        try {
            const $ = await this.fetch(url);
            const results: string[] = [];
            const selection = selector($);

            if (typeof selection === 'string') return [selection];

            selection.each((_, element) => {
                const text = $(element).text().trim();
                if (text) results.push(text);
            });

            return results;
        } catch (e) {
            if (e instanceof TyrError) throw e;
            throw new TyrError(`Could not select content from: ${url}`, e);
        }
    }
}

export const WebManagerTests = {
    selectFromWeb: {
        url: 'https://www.w3schools.com/',
        selector: ($: any) => $('title'),
    },
};
