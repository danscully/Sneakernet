MetFileSync

Description:
MetFileSync is a web app that syncs a directory on the server to other directories on the same server. Files are compared via datestamp and filesize, within a configurable delta.  

Technology stack:
- Node / JavaScript
- Svelte / Sveltekit for the front end. 
- Shadcn for Svelte for UI components. 
- Git for source control. 

Features:
- It should move files through native OS calls, through the Node C API.  The native code should provide some kind of progress tracking (either polling or callbacks) to update the gui. 
- Directories that are not present in the destination directory are automatically created
- All directories are based off a root path specified locally in the server deployment configuration. User inputted paths should be sanitized to not escape the root directory. 
- Settings should be savable as a “Sync Set”. It should be easy to change between Sync Sets. 
- The Sync Set should have an option to “sync deletions”.  If that is set to yes, files in a destination directory that are not in the source directory should be deleted. 
- The Sync Set should have an option for “Include Filters”, which is a list of partial paths. If this list is empty, all files and directories are included in the sync. If it is not empty, only files and directories which match one of the partial paths are included in the sync. The “*” should act as a wildcard symbol. 
- The Sync Set should have an option for “Exclude Filters”. It’s just like “Include Filters”, but files and directories that match items in the “Exclude Filters” are not copied. Exclusions should be applied after inclusions. 
- The Sync Set should have an option on how to handle errors. The options would be “stop on error”, “ignore all errors”, and “ask user”. 
- Files should be copied to a temporary name, and once the copy is complete, the temp file should be renamed to its true name. 
- Each destination directory is assigned a “group”. Destination directlries in the same group are synced in parallel from the source directory. By default each destination is assigned to group 1. There are 10 groups max. Groups should be synced in numerical order. 
- Syncing is a two part process. The first action a user takes is a Compare. During the Compare the app examines each destination directory and determines which files and directories need to be synced. Comparisons should happen in parallel like the syncs. 
- When the Compare is complete, the app should display to the user the files to be synced (including their name, path, size, and modified date). The user should be able to manually de-select files to exclude them from the sync. Deselecting the source item should de-select it for all destination folders.  De-selecting the destination item excludes it only for that destination. 
- The second step of the sync process is the sync itself. Only files found and selected in the Compare process should sync. New files added to the source directory after the Compare should not sync. 
- If a source item’s comparison metadata (file size and datestamp) since the Compare, and error should be presented to the user to confirm it should still be synced. 
- While syncing, the gui should show the following information for each destination: current file copying, rolling average of megabytes per sec being copied, elapsed time, remaining, total copied megabytes, and total remaining megabytes.  There should be a progress bar as well. 
- There should be a stop button for each destination and a stop all button. If an error is encountered, the destination directory with the error should pause, and present the error to the user. The user should be presented with the option to stop the sync, continue the sync, or continue the sync and ignore all future errors. 
- If the sync is stopped, the app should attempt to clean up any temp files it created in the destination directory. 
- The UI should be fairly dense. This is an app for power users. If elements, like a file list, need to scroll they should be contained within a scroll-enabled container, rather than the whole page scrolling. 
- The UI theming should be dark.
- All settings should be stored as JSON. Sync Sets should be importable/exportable as JSON files. 

Build Phases:
- make a Node module that makes native OS calls to copy files as fast as possible and provide progress back into the JavaScript context. Build test scaffolding for this. 
- Design any custom UI components needed (such as the table for files found in the Compare step). 
- Build the full UI and test. 
- Connect the UI with the server backend. 
- Build a test suite, test directories and files. Execute tests and fix bugs as found. 