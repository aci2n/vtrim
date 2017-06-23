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
	var bitrate = get_opt('bitrate', '1M');
	var size_hint = parse_size_hint(get_opt('size-hint', '1280:720'));
	var ext = get_opt('ext', 'webm');
	
	return {
		get_ffmpeg: function () { return ffmpeg; },
		get_bitrate: function () { return bitrate; },
		get_size_hint: function () { return size_hint; },
		get_ext: function () { return ext; }
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
	return typeof value === 'number' && !isNaN(value);
}


// Video resizing

function is_valid_dimension(dim) {
	return is_number(dim) && (dim > 0) && (dim % 2 === 0);
}

function parse_size_hint(value) {
	var hint = false;

	if (is_string(value)) {
		var tokens = value.split(':', 3);
		
		if (tokens.length >= 2) {
			var w = parseInt(tokens[0], 10);
			var h = parseInt(tokens[1], 10);
			
			if (is_valid_dimension(w) && is_valid_dimension(h)) {
				hint = {
					w: w,
					h: h,
					force: tokens[2] === 'force'
				};
			}
		}
	}

	return hint;
}

function round_even(num) {
	var op = num > 0 ? Math.floor : Math.ceil;
	return op(num + op(num % 2));
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
		w: round_even(w),
		h: round_even(h)
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

function print_info(message, duration) {
	mp.osd_message('[vtrim] ' + message, duration || 5);
	mp.msg.info(message);
}

function get_video_size() {
	var w = mp.get_property_number('width');
	var h = mp.get_property_number('height');

	return {
		w: w,
		h: h
	};
}

function get_audio_channels() {
	return mp.get_property('audio-params/channels');
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
	var bitrate = state.get_bitrate();
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
	if (bitrate) {
		args.push('-b:v');
		args.push(bitrate);
	}
	if (size_hint) {
		args.push('-s:v');
		args.push(calc_size_ffmpeg(size_hint, get_video_size()));
	}
	if (mode.no_audio) {
		args.push('-an');
	} else {
		// workaround for ffmpeg issue when encoding a 5.1(side) channel layout with libopus
		if (ext === 'webm' && get_audio_channels() === '5.1(side)') {
			args.push('-filter:a');
			args.push('channelmap=channel_layout=5.1');
		}
	}
	if (mode.no_subs) {
		args.push('-sn');
	}
	args.push(output);
	
	return args;
}

function ffmpeg_result(handle, detached, output) {
	if (detached) {
		return 'Running ffmpeg detached. Output: ' + output;
	}
	
	if (!is_object(handle)) {
		return 'Unexpected handle type: ' + (typeof handle);
	}
	
	if (handle.stderr) {
		return 'ffmpeg error: ' + handle.stderr;
	}
	
	if (handle.error) {
		return 'error: ' + handle.error;
	}
	
	return 'Output: ' + output;
}

function run_ffmpeg(start, end, mode) {
	var args = get_ffmpeg_args(start, end, mode);
	var subprocess_type = mode.detached ? 'subprocess_detached' : 'subprocess';
	var handle = mp.utils[subprocess_type]({
		args: args,
		cancellable: false
	});
	
	return ffmpeg_result(handle, mode.detached, args.pop());
}


// Handler helpers

function handle_start(mode) {
	var ab_loop = get_ab_loop();

	if (is_number(ab_loop.a) && is_number(ab_loop.b)) {
		cmd_ab_loop();
		trim_video(ab_loop.a, ab_loop.b, mode);
	} else {
		print_info('A-B loop not defined.');
	}
}

function trim_video(start, end, mode) {
	if (end > start) {
		print_info('Running... ' + mode_info(mode));
		var result = run_ffmpeg(start, end, mode);
		print_info(result);
	} else {
		print_info('End time can\'t be higher than start time.');
	}
}

function mode_info(mode) {
	var info = [];

	for (var key in mode) {
		info.push('[' + (mode[key] ? '+' : '-') + key + ']');
	}
	
	return info.join(' ');
}


// Main

(function main() {
	function create_handler(no_subs, no_audio, detached) {
		var mode = {
			no_subs: no_subs,
			no_audio: no_audio,
			detached: detached
		};
		
		return function handler() {
			handle_start(mode);
		};
	}

	mp.add_key_binding('n', 'default', create_handler(false, false, false));
	mp.add_key_binding('shift+n', 'no-subs', create_handler(true, false, false));
	mp.add_key_binding('ctrl+n', 'no-audio', create_handler(false, true, false));
	mp.add_key_binding('ctrl+shift+n', 'no-subs-no-audio', create_handler(true, true, false));

	mp.add_key_binding('alt+n', 'default-detached', create_handler(false, false, true));
	mp.add_key_binding('alt+shift+n', 'no-subs-detached', create_handler(true, false, true));
	mp.add_key_binding('alt+ctrl+n', 'no-audio-detached', create_handler(false, true, true));
	mp.add_key_binding('alt+ctrl+shift+n', 'no-subs-no-audio-detached', create_handler(true, true, true));
}());