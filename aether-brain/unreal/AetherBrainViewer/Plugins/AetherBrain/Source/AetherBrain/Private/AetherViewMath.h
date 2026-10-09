// The maths that keeps the brain viewer (AetherBrainActor) visible and cheap whatever the size of the vault: how big a body must
// be drawn so it is not lost at a distance, how often a big scene may be redrawn, whether the first places it was sent are real,
// and a fingerprint of the orbit rings so they are rebuilt only when they changed.
//
// Plain C++ with no Unreal types, so it is compiled and tested on an ordinary computer (unreal/tests/view_core_test.cpp).
// Lengths are cm, angles radians.
#pragma once

#include <algorithm>
#include <cmath>
#include <cstddef>
#include <cstdint>

namespace AetherView
{

/* ------------------------------------------------------------------------------------------------------------------ */
/* Seeing it                                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * The least angle, from the camera, between the centre of a body and its edge. A brain of a few thousand nodes is some
 * kilometres across at Unreal's scale while a moon is some tens of centimetres: from the distance that frames the whole of
 * it a moon is a fraction of a pixel and an orbit thread a hundredth of one, so correct data looked like dust with no
 * orbits. 0.0009 rad is about two pixels at 1920 across with the viewer's 55 degree view.
 */
constexpr double kMinNodeAngle = 0.0009;
/** The same for the threads (links and orbit rings): about one pixel thick. */
constexpr double kMinThreadAngle = 0.00035;

/** A body of RadiusCm seen from DistanceCm, drawn no smaller than MinAngle across: its own radius when close, larger when far. */
inline double ApparentRadius(double RadiusCm, double DistanceCm, double MinAngle)
{
	const double Far = std::isfinite(DistanceCm) && DistanceCm > 0.0 ? DistanceCm * MinAngle : 0.0;
	return std::max(RadiusCm, Far);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Paying for it                                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Seconds between two redraws of the scene at best (30 a second) and at worst. */
constexpr double kMinUpdateGap = 1.0 / 30.0;
constexpr double kMaxUpdateGap = 0.5;
/** The share of the time the redraw may take: one fifth, so the rest of the frame is the user's. */
constexpr double kUpdateShare = 5.0;

/**
 * How long to wait before redrawing the scene again, given how long the last redraw took. A small scene redraws at 30 a
 * second; a big one redraws less often instead of freezing the editor.
 */
inline double UpdateGap(double SpentSeconds)
{
	const double Spent = std::isfinite(SpentSeconds) && SpentSeconds > 0.0 ? SpentSeconds : 0.0;
	return std::min(std::max(Spent * kUpdateShare, kMinUpdateGap), kMaxUpdateGap);
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Believing what it is sent                                                                                            */
/* ------------------------------------------------------------------------------------------------------------------ */

/**
 * True when N places are not a layout: more than one node, all at the same spot (to a thousandth of a unit). That is what a
 * vault that has just been opened looks like before its layout is worked out; the camera must not be framed on it.
 * Coord(I, Axis) is axis 0, 1 or 2 of node I.
 */
template <typename CoordFn>
inline bool LooksUnplaced(int N, CoordFn Coord)
{
	for (int I = 1; I < N; ++I)
	{
		for (int Axis = 0; Axis < 3; ++Axis)
		{
			if (std::fabs(static_cast<double>(Coord(I, Axis)) - static_cast<double>(Coord(0, Axis))) > 1e-3)
			{
				return false;
			}
		}
	}
	return N >= 2;
}

/* ------------------------------------------------------------------------------------------------------------------ */
/* Knowing it changed                                                                                                   */
/* ------------------------------------------------------------------------------------------------------------------ */

/** Folds one orbit ring (its parent and radius, to 1/100 of a unit) into a running fingerprint (FNV-1a). Start from kRingSeed. */
constexpr uint32_t kRingSeed = 2166136261u;

inline uint32_t FoldRing(uint32_t Hash, int Parent, double Radius)
{
	const uint32_t Words[2] = {static_cast<uint32_t>(Parent), static_cast<uint32_t>(static_cast<int64_t>(std::llround(Radius * 100.0)))};
	for (uint32_t Word : Words)
	{
		for (int Byte = 0; Byte < 4; ++Byte)
		{
			Hash ^= (Word >> (8 * Byte)) & 0xffu;
			Hash *= 16777619u;
		}
	}
	return Hash;
}

}  // namespace AetherView
