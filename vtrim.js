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
	var ffmpeg = get_opt('ffmpeg', 'ffmpeg');
	var bps = get_opt('bps', false);
	var size_hint = parse_size_hint(get_opt('size-hint', false));
	var ext = get_opt('ext', false);
	var detached = get_opt('detached', false) === 'true';
	
	return {
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

function is_number(value) {
	return typeof value === 'number';
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

function get_ab_loop() {
	var a = mp.get_property_number('ab-loop-a');
	var b = mp.get_property_number('ab-loop-b');

	return {
		a: a,
		b: b
	};
}

function cmd_ab_loop() {
	mp.command('ab-loop');
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


// ffmpeg

function format_output_file(name, ext, start, end) {
	return name + ' [' + start.toFixed(3) + '-' + end.toFixed(3) + '].' + ext;
}

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
	var ab_loop = get_ab_loop();
	var mode = {
		no_subs: no_subs,
		no_audio: no_audio
	};
	
	if (is_number(ab_loop.a) && is_number(ab_loop.b)) {
		trim_video(ab_loop.a, ab_loop.b, mode);
	} else {
		osd_message('AB-loop not defined.');
	}
}

function trim_video(start, end, mode) {	
	if (end > start) {
		osd_message(mode_info(mode));
		var result = run_ffmpeg(start, end, mode);
		osd_message(result.info);
		cmd_ab_loop();
	} else {
		osd_message('End time can\'t be higher than start time.');
	}
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


// Main

(function main() {
	mp.add_key_binding('n', handle_start_all_enabled);
	mp.add_key_binding('shift+n', handle_start_no_subs);
	mp.add_key_binding('ctrl+n', handle_start_no_audio);
	mp.add_key_binding('alt+n', handle_start_no_subs_no_audio);
}());