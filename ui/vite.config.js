import { defineConfig } from "vite";

export default defineConfig({
    envPrefix: "PB",
    base: "./",
    server: {
        proxy: {
            "/api": {
                target: "http://127.0.0.1:8090",
                changeOrigin: true,
            },
        },
    },
    build: {
        chunkSizeWarningLimit: 1000,
        reportCompressedSize: false,
    },
    resolve: {
        alias: {
            "@": __dirname + "/src",
        },
    },
});
