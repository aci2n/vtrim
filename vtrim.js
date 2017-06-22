/*
	vtrim - A mpv user script to trim files using ffmpeg.
	Copyright (C) 2017  github.com/aci2n

    This program is free software: you can redistribute it and/or modify
    it under the terms of the GNU General Public License as published by
    the Free Software Foundation, either version 3 of the License, or
    (at your option) any later version.

    This program is distributed in the hope that it will be useful,
    but WITHOUT ANY WARRANTY; without even the implied warranty of
    MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
    GNU General Public License for more details.

    You should have received a copy of the GNU General Public License
    along with this program.  If not, see <http://www.gnu.org/licenses/>.
*/


// State

var state = (function state_initializer() {
	var start = null;
	var ffmpeg = get_opt('ffmpeg', 'ffmpeg');
	var bps = get_opt('bps', false);
	var size_hint = parse_size_hint(get_opt('size-hint', false));
	var ext = get_opt('ext', false);
	var detached = get_opt('detached', false) === 'true';
	
	return {
		get_start: function () { return start; },
		set_start: function (value) { start = value; },
		get_ffmpeg: function () { return ffmpeg; },
		get_bps: function () { return bps; },
		get_size_hint: function () { return size_hint; },
		get_ext: function () { return ext; },
		is_detached: function () { return detached; }
	};
}());


// Basic utilities

function is_string(value) {
	return typeof value === 'string';
}

function is_object(value) {
	return typeof value === 'object';
}


// Video resizing

function parse_size_hint(value) {
	var hint = false;

	if (is_string(value)) {
		var tokens = value.split(':', 3);

		if (tokens.length >= 2) {
			hint = {
				w: Number.parseInt(tokens[0], 10) || 0,
				h: Number.parseInt(tokens[1], 10) || 0,
				force: tokens[2] === 'force'
			};
		}
	}

	return hint;
}

function calc_size(hint, video_size) {
	if (hint.force) {
		return hint;
	}

	var video_px = video_size.w * video_size.h;
	var hint_px = hint.w * hint.h;

	if (video_px <= hint_px) {
		return video_size;
	}
	
	var ratio = video_size.w / video_size.h;
	var h = Math.sqrt(hint_px / ratio);
	var w = ratio * h;

	return {
		w: Math.round(w),
		h: Math.round(h)
	};
}


// mp.* wrappers

function get_playback_time() {
	return mp.get_property_number('playback-time');
}

function get_path() {
	var full = mp.get_property('path');
	var index = full.lastIndexOf('.');
	var ext = full.substring(index + 1);
	var no_ext = full.substring(0, index);
	
	return {
		full: full,
		ext: ext,
		no_ext: no_ext
	};
}

function get_opt(opt, def) {
	return mp.get_opt('vtrim-' + opt) || def;
}

function osd_message(message, duration) {
	mp.osd_message('[vtrim] ' + message, duration || 5);
}

function get_video_size() {
	var w = mp.get_property_number('width');
	var h = mp.get_property_number('height');

	return {
		w: w,
		h: h
	};
}


// Formatters

function format_output_file(name, ext, start, end) {
	return [name, format_time(start, true), format_time(end, true), ext].join('.');
}

function format_unit(value) {
	value = Math.floor(value).toString();
	return value.length === 1 ? '0' + value : value;
}

function format_ms(ms) {
	return ms.toFixed(3).substring(2);
}

function format_time(time, for_output) {
	var sep = ':';
	var ms_sep = '.';
	var seconds = Math.floor(time);
	var ms = time - seconds;
	var hh = seconds / 3600;
	var mm = seconds % 3600 / 60;
	var ss = seconds % 60;

	if (for_output) {
		sep = ms_sep = '-';
	}
	
	return format_unit(hh) + sep + format_unit(mm) + sep + format_unit(ss) + ms_sep + format_ms(ms);
}


// ffmpeg

function calc_size_ffmpeg(hint, video_size) {
	var result = calc_size(hint, video_size);
	return result.w + 'x' + result.h;
}

function get_ffmpeg_args(start, end, mode) {
	var path = get_path();
	var input = path.full;
	var ext = state.get_ext() || path.ext;
	var output = format_output_file(path.no_ext, ext, start, end);
	var duration = end - start;
	var bps = state.get_bps();
	var size_hint = state.get_size_hint();
	var loglevel = 'error';

	var args = [
		state.get_ffmpeg(),
		'-n',
		'-v',
		loglevel,
		'-ss',
		start,
		'-i',
		input,
		'-t',
		duration
	];
	if (bps) {
		args.push('-b:v');
		args.push(bps);
	}
	if (size_hint) {
		args.push('-s:v');
		args.push(calc_size_ffmpeg(size_hint, get_video_size()));
	}
	if (mode.no_audio) {
		args.push('-an');
	}
	if (mode.no_subs) {
		args.push('-sn');
	}
	args.push(output);
	
	return args;
}

function run_ffmpeg(start, end, mode) {
	var result = null;
	var args = get_ffmpeg_args(start, end, mode);
	var subprocess_type = state.is_detached() ? 'subprocess_detached' : 'subprocess';
	var handle = mp.utils[subprocess_type]({
		args: args,
		cancellable: false
	});
	
	if (is_object(handle) && is_string(handle.stderr) && handle.stderr !== '') {
		result = {
			error: true,
			info: 'ffmpeg error: ' + handle.stderr
		};
	} else {
		result = {
			error: false,
			info: 'Output file: ' + output
		};
	}
	
	return result;
}


// Handler helpers

function handle_start(no_subs, no_audio) {
	var start = state.get_start();
	var playback_time = get_playback_time();
	var mode = {
		no_subs: no_subs,
		no_audio: no_audio
	};
	
	if (start === null) {
		osd_message(format_time(playback_time));
		state.set_start(playback_time);
	} else {
		trim_video(start, playback_time, mode);
	}
}

function trim_video(start, end, mode) {
	var formatted_times = format_time(start) + ' / ' + format_time(end);
	
	if (end > start) {
		osd_message(formatted_times +  ' '  + mode_info(mode));
		var result = run_ffmpeg(start, end, mode);
		osd_message(result.info);
		reset();
	} else {
		osd_message('End time can\'t be higher than start time (' + formatted_times + ').');
	}
}

function reset() {
	state.set_start(null);
}

function mode_info(mode) {
	var info = [];

	for (var key in mode) {
		info.push('[' + (mode[key] ? '+' : '-') + key + ']');
	}
	
	return info.join(' ');
}


// Handlers

function handle_start_all_enabled() {
	handle_start(false, false);
}

function handle_start_no_subs() {
	handle_start(true, false);
}

function handle_start_no_audio() {
	handle_start(false, true);
}

function handle_start_no_subs_no_audio() {
	handle_start(true, true);
}

function handle_reset() {
	osd_message('Reset.');
	reset();
}


// Main

(function main() {
	mp.add_key_binding('n', handle_start_all_enabled);
	mp.add_key_binding('shift+n', handle_start_no_subs);
	mp.add_key_binding('ctrl+n', handle_start_no_audio);
	mp.add_key_binding('ctrl+shift+n', handle_start_no_subs_no_audio);
	mp.add_key_binding('alt+n', handle_reset);
}());