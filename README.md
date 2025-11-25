# MangaDex Downloader

A powerful and customizable browser extension to download manga chapters from MangaDex in various formats.

![Extension Screenshot](extension.PNG)

## Features

-   **Multiple Download Formats:** Save chapters as individual **Images**, compressed **ZIP** archives, or portable **PDF** documents.
-   **Bulk & Single Chapter Downloads:** Quickly download the chapter you are currently viewing or queue multiple chapters for download from a manga's main page.
-   **Language Filtering:** Easily find and download chapters in your preferred language.
-   **Advanced Concurrency Control:** Fine-tune the number of simultaneous chapter and image downloads to match your network speed and system capabilities.
-   **Robust Download Engine:** Features an automatic retry mechanism for failed images and intelligent page-load detection to prevent incomplete downloads.
-   **Organized File Structure:** Chapters are saved into a clean, easy-to-navigate folder structure: `Manga Title/Chapter Name/`.
-   **Modern & Intuitive UI:** A sleek, dark-themed popup interface that is easy to use.

## Installation

1.  **Download the code:** Download this repository as a ZIP file and extract it, or clone it from `https://github.com/Yui007/mangadex-extension`.
2.  **Open Browser Extensions:**
    -   **Chrome/Brave:** Navigate to `chrome://extensions`
    -   **Edge:** Navigate to `edge://extensions`
3.  **Enable Developer Mode:** Find and enable the "Developer mode" toggle, usually located in the top-right corner.
4.  **Load the Extension:** Click the **"Load unpacked"** button and select the directory where you extracted/cloned the code.

The MangaDex Downloader icon will now appear in your browser's toolbar.

## How to Use

### Important Tip
 - Make Sure to Enable Long Strip in Mangadex For chapters otherwise the extension will not work.

### On a Chapter Page (`mangadex.org/chapter/...`)

1.  Navigate to any manga chapter on MangaDex.
2.  Click the extension icon in your toolbar.
3.  Click the **"Download Current Chapter"** button. The chapter will be downloaded in the format specified in your settings.

### On a Manga Title Page (`mangadex.org/title/...`)

1.  Navigate to the main page for any manga series.
2.  Click the extension icon.
3.  Use the **language dropdown** to filter the chapter list.
4.  **Check the boxes** next to the chapters you wish to download.
5.  Click the **"Download Selected"** button. The chapters will be added to a queue and downloaded in the background.

## Settings

Click the **"Settings"** tab in the extension popup to configure the following options:

-   **Download As:** Choose the format for your downloads:
    -   `Images`: Saves each page as a separate image file (e.g., .png).
    -   `ZIP`: Compresses the entire chapter into a single `.zip` file.
    -   `PDF`: Compiles all chapter pages into a single `.pdf` document.
-   **Concurrent Chapters:** The number of chapters to process simultaneously (default: 3).
-   **Concurrent Images:** The number of images to download at the same time (for `Images` mode only, default: 5).
-   **Retry Count:** How many times to retry a failed image download (default: 3).
-   **Retry Delay (ms):** The wait time in milliseconds before a retry attempt (default: 1000).
-   **Stability Checks:** The number of 250ms intervals the page must be stable before starting a download. Increase this if chapters are not fully loading.
-   **Overall Timeout (s):** The maximum time to wait for a chapter's images to load.

Remember to click **"Save Settings"** after making any changes.

## Troubleshooting

-   **Incomplete downloads or "No images found":** Try increasing the "Stability Checks" and "Overall Timeout (s)" values in the settings. This is often necessary for very long chapters or on slower connections.
-   **Browser blocking downloads:** The extension may trigger your browser's protection against downloading multiple files at once. If prompted, always choose to "Allow" the downloads.
-   **Extension not working:** Ensure you are on a valid `mangadex.org` chapter or title page and reload the page.

## Contributing

Contributions are welcome! Feel free to open an issue or submit a pull request for any bugs, improvements, or feature suggestions on the [GitHub repository](https://github.com/Yui007/mangadex-extension).