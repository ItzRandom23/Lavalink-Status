"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Filters = void 0;
const filtersEqualizers_1 = require("../utils/filtersEqualizers");
class Filters {
    distortion;
    equalizer;
    karaoke;
    player;
    rotation;
    timescale;
    vibrato;
    volume;
    filterStatus;
    constructor(player) {
        this.distortion = null;
        this.equalizer = [];
        this.karaoke = null;
        this.player = player;
        this.rotation = null;
        this.timescale = null;
        this.vibrato = null;
        this.volume = 1.0;
        // Initialize filter status
        this.filterStatus = {
            bassboost: false,
            distort: false,
            eightD: false,
            karaoke: false,
            nightcore: false,
            slowmo: false,
            soft: false,
            trebleBass: false,
            tv: false,
            vaporwave: false,
        };
    }
    async updateFilters() {
        const { distortion, equalizer, karaoke, rotation, timescale, vibrato, volume } = this;
        await this.player.node.rest.updatePlayer({
            data: {
                filters: {
                    distortion,
                    equalizer,
                    karaoke,
                    rotation,
                    timescale,
                    vibrato,
                    volume,
                },
            },
            guildId: this.player.guild,
        });
        return this;
    }
    applyFilter(filter, updateFilters = true) {
        this[filter.property] = filter.value;
        if (updateFilters) {
            this.updateFilters();
        }
        return this;
    }
    setFilterStatus(filter, status) {
        this.filterStatus[filter] = status;
        return this;
    }
    /**
     * Sets the equalizer bands and updates the filters.
     * @param bands - The equalizer bands.
     */
    setEqualizer(bands) {
        return this.applyFilter({ property: "equalizer", value: bands });
    }
    /** Applies the eight dimension audio effect. */
    eightD() {
        return this.setRotation({ rotationHz: 0.2 }).setFilterStatus("eightD", true);
    }
    /** Applies the bass boost effect. */
    bassBoost() {
        return this.setEqualizer(filtersEqualizers_1.bassBoostEqualizer).setFilterStatus("bassboost", true);
    }
    /** Applies the nightcore effect. */
    nightcore() {
        return this.setTimescale({
            speed: 1.1,
            pitch: 1.125,
            rate: 1.05,
        }).setFilterStatus("nightcore", true);
    }
    /** Applies the slow motion audio effect. */
    slowmo() {
        return this.setTimescale({
            speed: 0.7,
            pitch: 1.0,
            rate: 0.8,
        }).setFilterStatus("slowmo", true);
    }
    /** Applies the soft audio effect. */
    soft() {
        return this.setEqualizer(filtersEqualizers_1.softEqualizer).setFilterStatus("soft", true);
    }
    /** Applies the television audio effect. */
    tv() {
        return this.setEqualizer(filtersEqualizers_1.tvEqualizer).setFilterStatus("tv", true);
    }
    /** Applies the treble bass effect. */
    trebleBass() {
        return this.setEqualizer(filtersEqualizers_1.trebleBassEqualizer).setFilterStatus("trebleBass", true);
    }
    /** Applies the vaporwave effect. */
    vaporwave() {
        return this.setEqualizer(filtersEqualizers_1.vaporwaveEqualizer).setTimescale({ pitch: 0.55 }).setFilterStatus("vaporwave", true);
    }
    /** Applies the distortion audio effect. */
    distort() {
        return this.setDistortion({
            sinOffset: 0,
            sinScale: 0.2,
            cosOffset: 0,
            cosScale: 0.2,
            tanOffset: 0,
            tanScale: 0.2,
            offset: 0,
            scale: 1.2,
        }).setFilterStatus("distort", true);
    }
    /** Applies the karaoke options specified by the filter. */
    setKaraoke(karaoke) {
        return this.applyFilter({
            property: "karaoke",
            value: karaoke,
        }).setFilterStatus("karaoke", true);
    }
    /** Applies the timescale options specified by the filter. */
    setTimescale(timescale) {
        return this.applyFilter({ property: "timescale", value: timescale });
    }
    /** Applies the vibrato options specified by the filter. */
    setVibrato(vibrato) {
        return this.applyFilter({ property: "vibrato", value: vibrato });
    }
    /** Applies the rotation options specified by the filter. */
    setRotation(rotation) {
        return this.applyFilter({ property: "rotation", value: rotation });
    }
    /** Applies the distortion options specified by the filter. */
    setDistortion(distortion) {
        return this.applyFilter({ property: "distortion", value: distortion });
    }
    /** Removes the audio effects and resets the filter status. */
    async clearFilters() {
        this.filterStatus = {
            bassboost: false,
            distort: false,
            eightD: false,
            karaoke: false,
            nightcore: false,
            slowmo: false,
            soft: false,
            trebleBass: false,
            tv: false,
            vaporwave: false,
        };
        this.player.filters = new Filters(this.player);
        this.setEqualizer([]);
        this.setDistortion(null);
        this.setKaraoke(null);
        this.setRotation(null);
        this.setTimescale(null);
        this.setVibrato(null);
        await this.updateFilters();
        return this;
    }
    /** Returns the status of the specified filter . */
    getFilterStatus(filter) {
        return this.filterStatus[filter];
    }
}
exports.Filters = Filters;
