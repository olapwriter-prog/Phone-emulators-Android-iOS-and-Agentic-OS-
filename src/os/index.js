import { AndroidOS } from './android.js';
import { IOS } from './ios.js';
import { LinuxOS } from './linux.js';
import { MacOS } from './macos.js';
import { AgenticOS } from './agentic.js';

export const OS_REGISTRY = { android: AndroidOS, ios: IOS, linux: LinuxOS, macos: MacOS, agentic: AgenticOS };
export { AndroidOS, IOS, LinuxOS, MacOS, AgenticOS };
