/**
 * General MIDI soundfont lookup tables.
 *
 * GM_BANK_NAMES[i] is the bank name strudel resolves for GM instrument index i
 * (matches the GmInstrument enum in crates/strudel-soundfont). GM_FONT_FILES[i][s]
 * is the WebAudioFont file (under felixroos.github.io/webaudiofontdata/sound) for
 * instrument i, variant s.
 *
 * Only fonts with verified licenses are listed: FluidR3_GM (Frank Wen, MIT) and
 * GeneralUser GS (S. Christian Collins, GeneralUser GS License v2.0). Variants
 * are FluidR3 first, then GeneralUserGS. See ATTRIBUTION.md.
 */

export const GM_FONT_FILES: readonly (readonly string[])[] = [
    // 0: Piano  (gm_piano - also covers BrightPiano:7, ElectricGrand:16, HonkyTonk:24)
    ['0000_FluidR3_GM_sf2_file', '0001_FluidR3_GM_sf2_file', '0000_GeneralUserGS_sf2_file', '0001_GeneralUserGS_sf2_file', '0002_GeneralUserGS_sf2_file', '0003_GeneralUserGS_sf2_file'],
    [], // 1: BrightPiano  - sub-bank of gm_piano, never canonical
    [], // 2: ElectricGrand - sub-bank of gm_piano, never canonical
    [], // 3: HonkyTonk    - sub-bank of gm_piano, never canonical
    // 4: EPiano1
    ['0040_FluidR3_GM_sf2_file', '0041_FluidR3_GM_sf2_file', '0040_GeneralUserGS_sf2_file', '0041_GeneralUserGS_sf2_file', '0042_GeneralUserGS_sf2_file', '0043_GeneralUserGS_sf2_file', '0044_GeneralUserGS_sf2_file', '0045_GeneralUserGS_sf2_file', '0046_GeneralUserGS_sf2_file'],
    // 5: EPiano2
    ['0050_FluidR3_GM_sf2_file', '0051_FluidR3_GM_sf2_file', '0050_GeneralUserGS_sf2_file', '0051_GeneralUserGS_sf2_file', '0052_GeneralUserGS_sf2_file', '0053_GeneralUserGS_sf2_file', '0054_GeneralUserGS_sf2_file'],
    // 6: Harpsichord
    ['0060_FluidR3_GM_sf2_file', '0060_GeneralUserGS_sf2_file', '0061_GeneralUserGS_sf2_file', '0062_GeneralUserGS_sf2_file'],
    // 7: Clavinet
    ['0070_FluidR3_GM_sf2_file', '0070_GeneralUserGS_sf2_file', '0071_GeneralUserGS_sf2_file'],
    // 8: Celesta
    ['0080_FluidR3_GM_sf2_file', '0081_FluidR3_GM_sf2_file', '0080_GeneralUserGS_sf2_file', '0081_GeneralUserGS_sf2_file'],
    // 9: Glockenspiel
    ['0090_FluidR3_GM_sf2_file', '0090_GeneralUserGS_sf2_file'],
    // 10: MusicBox
    ['0100_FluidR3_GM_sf2_file', '0100_GeneralUserGS_sf2_file', '0101_GeneralUserGS_sf2_file'],
    // 11: Vibraphone
    ['0110_FluidR3_GM_sf2_file', '0111_FluidR3_GM_sf2_file', '0110_GeneralUserGS_sf2_file'],
    // 12: Marimba
    ['0120_FluidR3_GM_sf2_file', '0121_FluidR3_GM_sf2_file', '0120_GeneralUserGS_sf2_file', '0121_GeneralUserGS_sf2_file'],
    // 13: Xylophone
    ['0130_FluidR3_GM_sf2_file', '0131_FluidR3_GM_sf2_file', '0130_GeneralUserGS_sf2_file'],
    // 14: TubularBells
    ['0140_FluidR3_GM_sf2_file', '0141_FluidR3_GM_sf2_file', '0140_GeneralUserGS_sf2_file', '0141_GeneralUserGS_sf2_file', '0142_GeneralUserGS_sf2_file', '0143_GeneralUserGS_sf2_file'],
    // 15: Dulcimer
    ['0150_FluidR3_GM_sf2_file', '0151_FluidR3_GM_sf2_file', '0150_GeneralUserGS_sf2_file'],
    // 16: DrawbarOrgan
    ['0160_FluidR3_GM_sf2_file', '0161_FluidR3_GM_sf2_file', '0160_GeneralUserGS_sf2_file'],
    // 17: PercussiveOrgan
    ['0170_FluidR3_GM_sf2_file', '0171_FluidR3_GM_sf2_file', '0172_FluidR3_GM_sf2_file', '0170_GeneralUserGS_sf2_file', '0171_GeneralUserGS_sf2_file'],
    // 18: RockOrgan
    ['0180_FluidR3_GM_sf2_file', '0180_GeneralUserGS_sf2_file', '0181_GeneralUserGS_sf2_file'],
    // 19: ChurchOrgan
    ['0190_FluidR3_GM_sf2_file', '0190_GeneralUserGS_sf2_file', '0191_GeneralUserGS_sf2_file'],
    // 20: ReedOrgan
    ['0200_FluidR3_GM_sf2_file', '0201_FluidR3_GM_sf2_file', '0200_GeneralUserGS_sf2_file', '0201_GeneralUserGS_sf2_file'],
    // 21: Accordion
    ['0210_FluidR3_GM_sf2_file', '0211_FluidR3_GM_sf2_file', '0210_GeneralUserGS_sf2_file', '0211_GeneralUserGS_sf2_file', '0212_GeneralUserGS_sf2_file'],
    // 22: Harmonica
    ['0220_FluidR3_GM_sf2_file', '0221_FluidR3_GM_sf2_file', '0220_GeneralUserGS_sf2_file'],
    // 23: Bandoneon
    ['0230_FluidR3_GM_sf2_file', '0231_FluidR3_GM_sf2_file', '0232_FluidR3_GM_sf2_file', '0233_FluidR3_GM_sf2_file', '0230_GeneralUserGS_sf2_file', '0231_GeneralUserGS_sf2_file'],
    // 24: NylonGuitar
    ['0240_FluidR3_GM_sf2_file', '0240_GeneralUserGS_sf2_file', '0241_GeneralUserGS_sf2_file'],
    // 25: SteelGuitar
    ['0250_FluidR3_GM_sf2_file', '0250_GeneralUserGS_sf2_file', '0251_GeneralUserGS_sf2_file', '0252_GeneralUserGS_sf2_file', '0253_GeneralUserGS_sf2_file', '0254_GeneralUserGS_sf2_file', '0255_GeneralUserGS_sf2_file'],
    // 26: JazzGuitar
    ['0260_FluidR3_GM_sf2_file', '0260_GeneralUserGS_sf2_file', '0261_GeneralUserGS_sf2_file'],
    // 27: CleanGuitar
    ['0270_FluidR3_GM_sf2_file', '0270_GeneralUserGS_sf2_file', '0271_GeneralUserGS_sf2_file'],
    // 28: MutedGuitar
    ['0280_FluidR3_GM_sf2_file', '0281_FluidR3_GM_sf2_file', '0282_FluidR3_GM_sf2_file', '0280_GeneralUserGS_sf2_file', '0281_GeneralUserGS_sf2_file', '0282_GeneralUserGS_sf2_file', '0283_GeneralUserGS_sf2_file'],
    // 29: OverdriveGuitar
    ['0290_FluidR3_GM_sf2_file', '0290_GeneralUserGS_sf2_file'],
    // 30: DistortionGuitar
    ['0300_FluidR3_GM_sf2_file', '0301_FluidR3_GM_sf2_file', '0300_GeneralUserGS_sf2_file', '0301_GeneralUserGS_sf2_file', '0302_GeneralUserGS_sf2_file'],
    // 31: GuitarHarmonics
    ['0310_FluidR3_GM_sf2_file', '0311_FluidR3_GM_sf2_file', '0310_GeneralUserGS_sf2_file', '0311_GeneralUserGS_sf2_file'],
    // 32: AcousticBass
    ['0320_FluidR3_GM_sf2_file', '0320_GeneralUserGS_sf2_file', '0321_GeneralUserGS_sf2_file', '0322_GeneralUserGS_sf2_file'],
    // 33: FingerBass
    ['0330_FluidR3_GM_sf2_file', '0330_GeneralUserGS_sf2_file', '0331_GeneralUserGS_sf2_file', '0332_GeneralUserGS_sf2_file'],
    // 34: PickBass
    ['0340_FluidR3_GM_sf2_file', '0340_GeneralUserGS_sf2_file', '0341_GeneralUserGS_sf2_file'],
    // 35: FretlessBass
    ['0350_FluidR3_GM_sf2_file', '0350_GeneralUserGS_sf2_file', '0351_GeneralUserGS_sf2_file'],
    // 36: SlapBass1
    ['0360_FluidR3_GM_sf2_file', '0360_GeneralUserGS_sf2_file', '0361_GeneralUserGS_sf2_file'],
    // 37: SlapBass2
    ['0370_FluidR3_GM_sf2_file', '0370_GeneralUserGS_sf2_file', '0371_GeneralUserGS_sf2_file', '0372_GeneralUserGS_sf2_file'],
    // 38: SynthBass1
    ['0380_FluidR3_GM_sf2_file', '0381_FluidR3_GM_sf2_file', '0382_FluidR3_GM_sf2_file', '0380_GeneralUserGS_sf2_file', '0381_GeneralUserGS_sf2_file', '0382_GeneralUserGS_sf2_file', '0383_GeneralUserGS_sf2_file', '0384_GeneralUserGS_sf2_file', '0385_GeneralUserGS_sf2_file', '0386_GeneralUserGS_sf2_file', '0387_GeneralUserGS_sf2_file'],
    // 39: SynthBass2
    ['0390_FluidR3_GM_sf2_file', '0391_FluidR3_GM_sf2_file', '0392_FluidR3_GM_sf2_file', '0390_GeneralUserGS_sf2_file', '0391_GeneralUserGS_sf2_file', '0392_GeneralUserGS_sf2_file', '0393_GeneralUserGS_sf2_file'],
    // 40: Violin
    ['0400_FluidR3_GM_sf2_file', '0401_FluidR3_GM_sf2_file', '0400_GeneralUserGS_sf2_file', '0401_GeneralUserGS_sf2_file', '0402_GeneralUserGS_sf2_file'],
    // 41: Viola
    ['0410_FluidR3_GM_sf2_file', '0411_FluidR3_GM_sf2_file', '0410_GeneralUserGS_sf2_file'],
    // 42: Cello
    ['0420_FluidR3_GM_sf2_file', '0421_FluidR3_GM_sf2_file', '0420_GeneralUserGS_sf2_file', '0421_GeneralUserGS_sf2_file'],
    // 43: Contrabass
    ['0430_FluidR3_GM_sf2_file', '0431_FluidR3_GM_sf2_file', '0430_GeneralUserGS_sf2_file'],
    // 44: TremoloStrings
    ['0440_FluidR3_GM_sf2_file', '0440_GeneralUserGS_sf2_file', '0441_GeneralUserGS_sf2_file', '0442_GeneralUserGS_sf2_file'],
    // 45: PizzicatoStrings
    ['0450_FluidR3_GM_sf2_file', '0451_FluidR3_GM_sf2_file', '0450_GeneralUserGS_sf2_file'],
    // 46: Harp
    ['0460_FluidR3_GM_sf2_file', '0461_FluidR3_GM_sf2_file', '0460_GeneralUserGS_sf2_file'],
    // 47: Timpani
    ['0470_FluidR3_GM_sf2_file', '0471_FluidR3_GM_sf2_file', '0470_GeneralUserGS_sf2_file', '0471_GeneralUserGS_sf2_file'],
    // 48: Strings1
    ['0480_FluidR3_GM_sf2_file', '0481_FluidR3_GM_sf2_file', '0480_GeneralUserGS_sf2_file', '0481_GeneralUserGS_sf2_file', '0482_GeneralUserGS_sf2_file', '0483_GeneralUserGS_sf2_file', '0484_GeneralUserGS_sf2_file', '0485_GeneralUserGS_sf2_file', '0486_GeneralUserGS_sf2_file', '0487_GeneralUserGS_sf2_file', '0488_GeneralUserGS_sf2_file', '0489_GeneralUserGS_sf2_file'],
    // 49: Strings2
    ['0490_FluidR3_GM_sf2_file', '0490_GeneralUserGS_sf2_file', '0491_GeneralUserGS_sf2_file', '0492_GeneralUserGS_sf2_file'],
    // 50: SynthStrings1
    ['0500_FluidR3_GM_sf2_file', '0501_FluidR3_GM_sf2_file', '0502_FluidR3_GM_sf2_file', '0503_FluidR3_GM_sf2_file', '0504_FluidR3_GM_sf2_file', '0505_FluidR3_GM_sf2_file', '0500_GeneralUserGS_sf2_file', '0501_GeneralUserGS_sf2_file', '0502_GeneralUserGS_sf2_file'],
    // 51: SynthStrings2
    ['0510_FluidR3_GM_sf2_file', '0510_GeneralUserGS_sf2_file', '0511_GeneralUserGS_sf2_file'],
    // 52: ChoirAahs
    ['0520_FluidR3_GM_sf2_file', '0521_FluidR3_GM_sf2_file', '0520_GeneralUserGS_sf2_file'],
    // 53: VoiceOohs
    ['0530_FluidR3_GM_sf2_file', '0531_FluidR3_GM_sf2_file', '0530_GeneralUserGS_sf2_file', '0531_GeneralUserGS_sf2_file'],
    // 54: SynthVoice
    ['0540_FluidR3_GM_sf2_file', '0541_FluidR3_GM_sf2_file', '0540_GeneralUserGS_sf2_file'],
    // 55: OrchestraHit
    ['0550_FluidR3_GM_sf2_file', '0551_FluidR3_GM_sf2_file', '0550_GeneralUserGS_sf2_file'],
    // 56: Trumpet
    ['0560_FluidR3_GM_sf2_file', '0560_GeneralUserGS_sf2_file'],
    // 57: Trombone
    ['0570_FluidR3_GM_sf2_file', '0570_GeneralUserGS_sf2_file', '0571_GeneralUserGS_sf2_file'],
    // 58: Tuba
    ['0580_FluidR3_GM_sf2_file', '0580_GeneralUserGS_sf2_file', '0581_GeneralUserGS_sf2_file'],
    // 59: MutedTrumpet
    ['0590_FluidR3_GM_sf2_file', '0590_GeneralUserGS_sf2_file', '0591_GeneralUserGS_sf2_file'],
    // 60: FrenchHorn
    ['0600_FluidR3_GM_sf2_file', '0601_FluidR3_GM_sf2_file', '0600_GeneralUserGS_sf2_file', '0601_GeneralUserGS_sf2_file', '0602_GeneralUserGS_sf2_file', '0603_GeneralUserGS_sf2_file'],
    // 61: BrassSection
    ['0610_FluidR3_GM_sf2_file', '0610_GeneralUserGS_sf2_file', '0611_GeneralUserGS_sf2_file', '0612_GeneralUserGS_sf2_file', '0613_GeneralUserGS_sf2_file', '0614_GeneralUserGS_sf2_file', '0615_GeneralUserGS_sf2_file'],
    // 62: SynthBrass1
    ['0620_FluidR3_GM_sf2_file', '0621_FluidR3_GM_sf2_file', '0622_FluidR3_GM_sf2_file', '0620_GeneralUserGS_sf2_file', '0621_GeneralUserGS_sf2_file', '0622_GeneralUserGS_sf2_file'],
    // 63: SynthBrass2
    ['0630_FluidR3_GM_sf2_file', '0631_FluidR3_GM_sf2_file', '0632_FluidR3_GM_sf2_file', '0633_FluidR3_GM_sf2_file', '0630_GeneralUserGS_sf2_file', '0631_GeneralUserGS_sf2_file'],
    // 64: SopranoSax
    ['0640_FluidR3_GM_sf2_file', '0641_FluidR3_GM_sf2_file', '0640_GeneralUserGS_sf2_file'],
    // 65: AltoSax
    ['0650_FluidR3_GM_sf2_file', '0651_FluidR3_GM_sf2_file', '0650_GeneralUserGS_sf2_file'],
    // 66: TenorSax
    ['0660_FluidR3_GM_sf2_file', '0661_FluidR3_GM_sf2_file', '0660_GeneralUserGS_sf2_file', '0661_GeneralUserGS_sf2_file'],
    // 67: BaritoneSax
    ['0670_FluidR3_GM_sf2_file', '0671_FluidR3_GM_sf2_file', '0670_GeneralUserGS_sf2_file'],
    // 68: Oboe
    ['0680_FluidR3_GM_sf2_file', '0681_FluidR3_GM_sf2_file', '0680_GeneralUserGS_sf2_file'],
    // 69: EnglishHorn
    ['0690_FluidR3_GM_sf2_file', '0691_FluidR3_GM_sf2_file', '0690_GeneralUserGS_sf2_file'],
    // 70: Bassoon
    ['0700_FluidR3_GM_sf2_file', '0701_FluidR3_GM_sf2_file', '0700_GeneralUserGS_sf2_file', '0701_GeneralUserGS_sf2_file'],
    // 71: Clarinet
    ['0710_FluidR3_GM_sf2_file', '0711_FluidR3_GM_sf2_file', '0710_GeneralUserGS_sf2_file'],
    // 72: Piccolo
    ['0720_FluidR3_GM_sf2_file', '0721_FluidR3_GM_sf2_file', '0720_GeneralUserGS_sf2_file'],
    // 73: Flute
    ['0730_FluidR3_GM_sf2_file', '0731_FluidR3_GM_sf2_file', '0730_GeneralUserGS_sf2_file'],
    // 74: Recorder
    ['0740_FluidR3_GM_sf2_file', '0740_GeneralUserGS_sf2_file', '0741_GeneralUserGS_sf2_file'],
    // 75: PanFlute
    ['0750_FluidR3_GM_sf2_file', '0751_FluidR3_GM_sf2_file', '0750_GeneralUserGS_sf2_file', '0751_GeneralUserGS_sf2_file'],
    // 76: BlownBottle
    ['0760_FluidR3_GM_sf2_file', '0761_FluidR3_GM_sf2_file', '0760_GeneralUserGS_sf2_file', '0761_GeneralUserGS_sf2_file', '0762_GeneralUserGS_sf2_file'],
    // 77: Shakuhachi
    ['0770_FluidR3_GM_sf2_file', '0771_FluidR3_GM_sf2_file', '0770_GeneralUserGS_sf2_file', '0771_GeneralUserGS_sf2_file', '0772_GeneralUserGS_sf2_file'],
    // 78: Whistle
    ['0780_FluidR3_GM_sf2_file', '0780_GeneralUserGS_sf2_file', '0781_GeneralUserGS_sf2_file'],
    // 79: Ocarina
    ['0790_FluidR3_GM_sf2_file', '0790_GeneralUserGS_sf2_file', '0791_GeneralUserGS_sf2_file'],
    // 80: Lead1Square
    ['0800_FluidR3_GM_sf2_file', '0801_FluidR3_GM_sf2_file', '0800_GeneralUserGS_sf2_file', '0801_GeneralUserGS_sf2_file'],
    // 81: Lead2Sawtooth
    ['0810_FluidR3_GM_sf2_file', '0810_GeneralUserGS_sf2_file', '0811_GeneralUserGS_sf2_file'],
    // 82: Lead3Calliope
    ['0820_FluidR3_GM_sf2_file', '0821_FluidR3_GM_sf2_file', '0820_GeneralUserGS_sf2_file', '0821_GeneralUserGS_sf2_file', '0822_GeneralUserGS_sf2_file', '0823_GeneralUserGS_sf2_file'],
    // 83: Lead4Chiff
    ['0830_FluidR3_GM_sf2_file', '0831_FluidR3_GM_sf2_file', '0830_GeneralUserGS_sf2_file', '0831_GeneralUserGS_sf2_file'],
    // 84: Lead5Charang
    ['0840_FluidR3_GM_sf2_file', '0841_FluidR3_GM_sf2_file', '0842_FluidR3_GM_sf2_file', '0840_GeneralUserGS_sf2_file', '0841_GeneralUserGS_sf2_file'],
    // 85: Lead6Voice
    ['0850_FluidR3_GM_sf2_file', '0851_FluidR3_GM_sf2_file', '0850_GeneralUserGS_sf2_file', '0851_GeneralUserGS_sf2_file'],
    // 86: Lead7Fifths
    ['0860_FluidR3_GM_sf2_file', '0861_FluidR3_GM_sf2_file', '0860_GeneralUserGS_sf2_file'],
    // 87: Lead8BassLead
    ['0870_FluidR3_GM_sf2_file', '0870_GeneralUserGS_sf2_file', '0871_GeneralUserGS_sf2_file', '0872_GeneralUserGS_sf2_file', '0873_GeneralUserGS_sf2_file'],
    // 88: Pad1NewAge
    ['0880_FluidR3_GM_sf2_file', '0881_FluidR3_GM_sf2_file', '0882_FluidR3_GM_sf2_file', '0880_GeneralUserGS_sf2_file', '0881_GeneralUserGS_sf2_file', '0882_GeneralUserGS_sf2_file', '0883_GeneralUserGS_sf2_file', '0884_GeneralUserGS_sf2_file', '0885_GeneralUserGS_sf2_file', '0886_GeneralUserGS_sf2_file', '0887_GeneralUserGS_sf2_file', '0888_GeneralUserGS_sf2_file', '0889_GeneralUserGS_sf2_file'],
    // 89: Pad2Warm
    ['0890_FluidR3_GM_sf2_file', '0891_FluidR3_GM_sf2_file', '0890_GeneralUserGS_sf2_file', '0891_GeneralUserGS_sf2_file'],
    // 90: Pad3Polysynth
    ['0900_FluidR3_GM_sf2_file', '0901_FluidR3_GM_sf2_file', '0900_GeneralUserGS_sf2_file', '0901_GeneralUserGS_sf2_file'],
    // 91: Pad4Choir
    ['0910_FluidR3_GM_sf2_file', '0910_GeneralUserGS_sf2_file', '0911_GeneralUserGS_sf2_file'],
    // 92: Pad5Bowed
    ['0920_FluidR3_GM_sf2_file', '0920_GeneralUserGS_sf2_file', '0921_GeneralUserGS_sf2_file'],
    // 93: Pad6Metallic
    ['0930_FluidR3_GM_sf2_file', '0931_FluidR3_GM_sf2_file', '0930_GeneralUserGS_sf2_file', '0931_GeneralUserGS_sf2_file'],
    // 94: Pad7Halo
    ['0940_FluidR3_GM_sf2_file', '0941_FluidR3_GM_sf2_file', '0940_GeneralUserGS_sf2_file', '0941_GeneralUserGS_sf2_file'],
    // 95: Pad8Sweep
    ['0950_FluidR3_GM_sf2_file', '0951_FluidR3_GM_sf2_file', '0950_GeneralUserGS_sf2_file', '0951_GeneralUserGS_sf2_file'],
    // 96: Fx1Rain
    ['0960_FluidR3_GM_sf2_file', '0961_FluidR3_GM_sf2_file', '0960_GeneralUserGS_sf2_file', '0961_GeneralUserGS_sf2_file', '0962_GeneralUserGS_sf2_file'],
    // 97: Fx2Soundtrack
    ['0970_FluidR3_GM_sf2_file', '0971_FluidR3_GM_sf2_file', '0970_GeneralUserGS_sf2_file', '0971_GeneralUserGS_sf2_file'],
    // 98: Fx3Crystal
    ['0980_FluidR3_GM_sf2_file', '0981_FluidR3_GM_sf2_file', '0980_GeneralUserGS_sf2_file', '0981_GeneralUserGS_sf2_file', '0982_GeneralUserGS_sf2_file', '0983_GeneralUserGS_sf2_file', '0984_GeneralUserGS_sf2_file'],
    // 99: Fx4Atmosphere
    ['0990_FluidR3_GM_sf2_file', '0991_FluidR3_GM_sf2_file', '0992_FluidR3_GM_sf2_file', '0990_GeneralUserGS_sf2_file', '0991_GeneralUserGS_sf2_file'],
    // 100: Fx5Brightness
    ['1000_FluidR3_GM_sf2_file', '1001_FluidR3_GM_sf2_file', '1002_FluidR3_GM_sf2_file', '1000_GeneralUserGS_sf2_file', '1001_GeneralUserGS_sf2_file', '1002_GeneralUserGS_sf2_file'],
    // 101: Fx6Goblins
    ['1010_FluidR3_GM_sf2_file', '1011_FluidR3_GM_sf2_file', '1010_GeneralUserGS_sf2_file'],
    // 102: Fx7Echoes
    ['1020_FluidR3_GM_sf2_file', '1021_FluidR3_GM_sf2_file', '1020_GeneralUserGS_sf2_file', '1021_GeneralUserGS_sf2_file', '1022_GeneralUserGS_sf2_file'],
    // 103: Fx8SciFi
    ['1030_FluidR3_GM_sf2_file', '1031_FluidR3_GM_sf2_file', '1032_FluidR3_GM_sf2_file', '1030_GeneralUserGS_sf2_file', '1031_GeneralUserGS_sf2_file'],
    // 104: Sitar
    ['1040_FluidR3_GM_sf2_file', '1041_FluidR3_GM_sf2_file', '1040_GeneralUserGS_sf2_file', '1041_GeneralUserGS_sf2_file'],
    // 105: Banjo
    ['1050_FluidR3_GM_sf2_file', '1050_GeneralUserGS_sf2_file', '1051_GeneralUserGS_sf2_file'],
    // 106: Shamisen
    ['1060_FluidR3_GM_sf2_file', '1061_FluidR3_GM_sf2_file', '1060_GeneralUserGS_sf2_file', '1061_GeneralUserGS_sf2_file'],
    // 107: Koto
    ['1070_FluidR3_GM_sf2_file', '1071_FluidR3_GM_sf2_file', '1070_GeneralUserGS_sf2_file', '1071_GeneralUserGS_sf2_file', '1072_GeneralUserGS_sf2_file', '1073_GeneralUserGS_sf2_file'],
    // 108: Kalimba
    ['1080_FluidR3_GM_sf2_file', '1080_GeneralUserGS_sf2_file'],
    // 109: Bagpipe
    ['1090_FluidR3_GM_sf2_file', '1090_GeneralUserGS_sf2_file'],
    // 110: Fiddle
    ['1100_FluidR3_GM_sf2_file', '1101_FluidR3_GM_sf2_file', '1100_GeneralUserGS_sf2_file', '1101_GeneralUserGS_sf2_file', '1102_GeneralUserGS_sf2_file'],
    // 111: Shanai
    ['1110_FluidR3_GM_sf2_file', '1110_GeneralUserGS_sf2_file'],
    // 112: TinkleBell
    ['1120_FluidR3_GM_sf2_file', '1120_GeneralUserGS_sf2_file'],
    // 113: Agogo
    ['1130_FluidR3_GM_sf2_file', '1131_FluidR3_GM_sf2_file', '1130_GeneralUserGS_sf2_file'],
    // 114: SteelDrums
    ['1140_FluidR3_GM_sf2_file', '1141_FluidR3_GM_sf2_file', '1140_GeneralUserGS_sf2_file'],
    // 115: Woodblock
    ['1150_FluidR3_GM_sf2_file', '1151_FluidR3_GM_sf2_file', '1152_FluidR3_GM_sf2_file', '1150_GeneralUserGS_sf2_file', '1151_GeneralUserGS_sf2_file', '1152_GeneralUserGS_sf2_file'],
    // 116: TaikoDrum
    ['1160_FluidR3_GM_sf2_file', '1161_FluidR3_GM_sf2_file', '1162_FluidR3_GM_sf2_file', '1163_FluidR3_GM_sf2_file', '1160_GeneralUserGS_sf2_file', '1161_GeneralUserGS_sf2_file', '1162_GeneralUserGS_sf2_file'],
    // 117: MelodicTom
    ['1170_FluidR3_GM_sf2_file', '1171_FluidR3_GM_sf2_file', '1172_FluidR3_GM_sf2_file', '1173_FluidR3_GM_sf2_file', '1170_GeneralUserGS_sf2_file', '1171_GeneralUserGS_sf2_file'],
    // 118: SynthDrum
    ['1180_FluidR3_GM_sf2_file', '1181_FluidR3_GM_sf2_file', '1180_GeneralUserGS_sf2_file', '1181_GeneralUserGS_sf2_file'],
    // 119: ReverseCymbal
    ['1190_FluidR3_GM_sf2_file', '1190_GeneralUserGS_sf2_file', '1191_GeneralUserGS_sf2_file', '1192_GeneralUserGS_sf2_file', '1193_GeneralUserGS_sf2_file', '1194_GeneralUserGS_sf2_file'],
    // 120: GuitarFretNoise
    ['1200_FluidR3_GM_sf2_file', '1200_GeneralUserGS_sf2_file', '1201_GeneralUserGS_sf2_file', '1202_GeneralUserGS_sf2_file'],
    // 121: BreathNoise
    ['1210_FluidR3_GM_sf2_file', '1210_GeneralUserGS_sf2_file', '1211_GeneralUserGS_sf2_file', '1212_GeneralUserGS_sf2_file'],
    // 122: Seashore
    ['1220_FluidR3_GM_sf2_file', '1220_GeneralUserGS_sf2_file', '1221_GeneralUserGS_sf2_file', '1222_GeneralUserGS_sf2_file', '1223_GeneralUserGS_sf2_file', '1224_GeneralUserGS_sf2_file', '1225_GeneralUserGS_sf2_file', '1226_GeneralUserGS_sf2_file'],
    // 123: BirdTweet
    ['1230_FluidR3_GM_sf2_file', '1230_GeneralUserGS_sf2_file', '1231_GeneralUserGS_sf2_file', '1232_GeneralUserGS_sf2_file', '1233_GeneralUserGS_sf2_file', '1234_GeneralUserGS_sf2_file'],
    // 124: TelephoneRing
    ['1240_FluidR3_GM_sf2_file', '1240_GeneralUserGS_sf2_file', '1241_GeneralUserGS_sf2_file', '1242_GeneralUserGS_sf2_file', '1243_GeneralUserGS_sf2_file', '1244_GeneralUserGS_sf2_file'],
    // 125: Helicopter
    ['1250_FluidR3_GM_sf2_file', '1251_FluidR3_GM_sf2_file', '1252_FluidR3_GM_sf2_file', '1250_GeneralUserGS_sf2_file', '1251_GeneralUserGS_sf2_file', '1252_GeneralUserGS_sf2_file', '1253_GeneralUserGS_sf2_file', '1254_GeneralUserGS_sf2_file', '1255_GeneralUserGS_sf2_file', '1256_GeneralUserGS_sf2_file', '1257_GeneralUserGS_sf2_file', '1258_GeneralUserGS_sf2_file', '1259_GeneralUserGS_sf2_file'],
    // 126: Applause
    ['1260_FluidR3_GM_sf2_file', '1260_GeneralUserGS_sf2_file', '1261_GeneralUserGS_sf2_file', '1262_GeneralUserGS_sf2_file', '1263_GeneralUserGS_sf2_file', '1264_GeneralUserGS_sf2_file', '1265_GeneralUserGS_sf2_file'],
    // 127: Gunshot
    ['1270_FluidR3_GM_sf2_file', '1270_GeneralUserGS_sf2_file', '1271_GeneralUserGS_sf2_file', '1272_GeneralUserGS_sf2_file', '1273_GeneralUserGS_sf2_file', '1274_GeneralUserGS_sf2_file'],
];

export const GM_BANK_NAMES: readonly string[] = [
    // Pianos (0-7)
    'gm_piano', 'gm_piano', 'gm_piano', 'gm_piano',
    'gm_epiano1', 'gm_epiano2', 'gm_harpsichord', 'gm_clavinet',
    // Chromatic Percussion (8-15)
    'gm_celesta', 'gm_glockenspiel', 'gm_music_box', 'gm_vibraphone',
    'gm_marimba', 'gm_xylophone', 'gm_tubular_bells', 'gm_dulcimer',
    // Organs (16-23)
    'gm_drawbar_organ', 'gm_percussive_organ', 'gm_rock_organ', 'gm_church_organ',
    'gm_reed_organ', 'gm_accordion', 'gm_harmonica', 'gm_bandoneon',
    // Guitars (24-31)
    'gm_acoustic_guitar_nylon', 'gm_acoustic_guitar_steel', 'gm_electric_guitar_jazz', 'gm_electric_guitar_clean',
    'gm_electric_guitar_muted', 'gm_overdriven_guitar', 'gm_distortion_guitar', 'gm_guitar_harmonics',
    // Bass (32-39)
    'gm_acoustic_bass', 'gm_electric_bass_finger', 'gm_electric_bass_pick', 'gm_fretless_bass',
    'gm_slap_bass_1', 'gm_slap_bass_2', 'gm_synth_bass_1', 'gm_synth_bass_2',
    // Strings (40-47)
    'gm_violin', 'gm_viola', 'gm_cello', 'gm_contrabass',
    'gm_tremolo_strings', 'gm_pizzicato_strings', 'gm_orchestral_harp', 'gm_timpani',
    // Ensemble (48-55)
    'gm_string_ensemble_1', 'gm_string_ensemble_2', 'gm_synth_strings_1', 'gm_synth_strings_2',
    'gm_choir_aahs', 'gm_voice_oohs', 'gm_synth_choir', 'gm_orchestra_hit',
    // Brass (56-63)
    'gm_trumpet', 'gm_trombone', 'gm_tuba', 'gm_muted_trumpet',
    'gm_french_horn', 'gm_brass_section', 'gm_synth_brass_1', 'gm_synth_brass_2',
    // Reed (64-71)
    'gm_soprano_sax', 'gm_alto_sax', 'gm_tenor_sax', 'gm_baritone_sax',
    'gm_oboe', 'gm_english_horn', 'gm_bassoon', 'gm_clarinet',
    // Pipe (72-79)
    'gm_piccolo', 'gm_flute', 'gm_recorder', 'gm_pan_flute',
    'gm_blown_bottle', 'gm_shakuhachi', 'gm_whistle', 'gm_ocarina',
    // Synth Lead (80-87)
    'gm_lead_1_square', 'gm_lead_2_sawtooth', 'gm_lead_3_calliope', 'gm_lead_4_chiff',
    'gm_lead_5_charang', 'gm_lead_6_voice', 'gm_lead_7_fifths', 'gm_lead_8_bass_lead',
    // Synth Pad (88-95)
    'gm_pad_new_age', 'gm_pad_warm', 'gm_pad_poly', 'gm_pad_choir',
    'gm_pad_bowed', 'gm_pad_metallic', 'gm_pad_halo', 'gm_pad_sweep',
    // Synth Effects (96-103)
    'gm_fx_rain', 'gm_fx_soundtrack', 'gm_fx_crystal', 'gm_fx_atmosphere',
    'gm_fx_brightness', 'gm_fx_goblins', 'gm_fx_echoes', 'gm_fx_sci_fi',
    // Ethnic (104-111)
    'gm_sitar', 'gm_banjo', 'gm_shamisen', 'gm_koto',
    'gm_kalimba', 'gm_bagpipe', 'gm_fiddle', 'gm_shanai',
    // Percussive (112-119)
    'gm_tinkle_bell', 'gm_agogo', 'gm_steel_drums', 'gm_woodblock',
    'gm_taiko_drum', 'gm_melodic_tom', 'gm_synth_drum', 'gm_reverse_cymbal',
    // Sound Effects (120-127)
    'gm_guitar_fret_noise', 'gm_breath_noise', 'gm_seashore', 'gm_bird_tweet',
    'gm_telephone', 'gm_helicopter', 'gm_applause', 'gm_gunshot',
];
