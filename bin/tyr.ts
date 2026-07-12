import { Kernel } from '../src/core/Kernel.ts';

(async () => {
    try {
        const kernel = new Kernel();
        const args = process.argv.slice(2);
        await kernel.boot(args);
        await kernel.handle(args);
    } catch (error) {
        console.error("Error fatal:");
        console.error(error);
        process.exit(1);
    }
})();