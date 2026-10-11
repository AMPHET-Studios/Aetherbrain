// Software pictures of the 8K sky, suns and corona (Private/AetherSkyMath.h): the full-size maps are made exactly as the
// viewer makes them, then shown as a person would see them: downsampled, a 1:1 crop, a rectilinear view out of the sky, a
// sun ball with limb darkening and its corona. A check and a preview, not the renderer.
// Run with unreal/tests/sky_preview.sh <output folder> [width] (width 8192 by default: the real size).
#include "../AetherBrainViewer/Plugins/AetherBrain/Source/AetherBrain/Private/AetherSkyMath.h"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>

using namespace AetherSky;

namespace
{
using Clock = std::chrono::steady_clock;
double Since(Clock::time_point T0) { return std::chrono::duration<double>(Clock::now() - T0).count(); }

void WritePpm(const std::string& Path, int W, int H, const std::vector<uint8_t>& Rgb8)
{
	FILE* F = std::fopen(Path.c_str(), "wb");
	if (F == nullptr)
	{
		std::fprintf(stderr, "cannot write %s\n", Path.c_str());
		std::exit(1);
	}
	std::fprintf(F, "P6\n%d %d\n255\n", W, H);
	std::fwrite(Rgb8.data(), 1, Rgb8.size(), F);
	std::fclose(F);
}

/** Box-filtered reduction by an integer factor, in linear light. */
std::vector<uint8_t> Downsample(const Image& Img, int Factor, int& OutW, int& OutH)
{
	OutW = Img.Width / Factor;
	OutH = Img.Height / Factor;
	std::vector<uint8_t> Out(static_cast<size_t>(OutW) * static_cast<size_t>(OutH) * 3U);
	for (int Y = 0; Y < OutH; ++Y)
	{
		for (int X = 0; X < OutW; ++X)
		{
			double R = 0.0;
			double G = 0.0;
			double B = 0.0;
			for (int Dy = 0; Dy < Factor; ++Dy)
			{
				for (int Dx = 0; Dx < Factor; ++Dx)
				{
					double Pr = 0.0;
					double Pg = 0.0;
					double Pb = 0.0;
					Img.Get(X * Factor + Dx, Y * Factor + Dy, Pr, Pg, Pb);
					R += Pr;
					G += Pg;
					B += Pb;
				}
			}
			const double N = static_cast<double>(Factor * Factor);
			const size_t O = (static_cast<size_t>(Y) * static_cast<size_t>(OutW) + static_cast<size_t>(X)) * 3U;
			Out[O + 0] = AetherSpace::ToSrgb8(R / N);
			Out[O + 1] = AetherSpace::ToSrgb8(G / N);
			Out[O + 2] = AetherSpace::ToSrgb8(B / N);
		}
	}
	return Out;
}

std::vector<uint8_t> Crop(const Image& Img, int X0, int Y0, int W, int H)
{
	std::vector<uint8_t> Out(static_cast<size_t>(W) * static_cast<size_t>(H) * 3U);
	for (int Y = 0; Y < H; ++Y)
	{
		for (int X = 0; X < W; ++X)
		{
			const size_t S = Img.Offset(X0 + X, Y0 + Y);
			const size_t O = (static_cast<size_t>(Y) * static_cast<size_t>(W) + static_cast<size_t>(X)) * 3U;
			Out[O + 0] = Img.Bgra[S + 2];
			Out[O + 1] = Img.Bgra[S + 1];
			Out[O + 2] = Img.Bgra[S + 0];
		}
	}
	return Out;
}

/** Bilinear sample of an equirectangular picture in linear light (wraps in longitude). */
Rgb SampleEquirect(const Image& Img, const Vec3& D)
{
	const double Lon = std::atan2(D.Y, D.X);
	const double Lat = std::asin(Clamp(D.Z, -1.0, 1.0));
	const double Fx = (Lon + kPi) / kTwoPi * static_cast<double>(Img.Width) - 0.5;
	const double Fy = (kPi * 0.5 - Lat) / kPi * static_cast<double>(Img.Height) - 0.5;
	const int X0 = static_cast<int>(std::floor(Fx));
	const int Y0 = static_cast<int>(std::floor(Fy));
	const double Tx = Fx - static_cast<double>(X0);
	const double Ty = Fy - static_cast<double>(Y0);
	Rgb Acc;
	for (int K = 0; K < 4; ++K)
	{
		const int Dx = K & 1;
		const int Dy = K >> 1;
		const int Px = ((X0 + Dx) % Img.Width + Img.Width) % Img.Width;
		const int Py = std::max(0, std::min(Img.Height - 1, Y0 + Dy));
		double R = 0.0;
		double G = 0.0;
		double B = 0.0;
		Img.Get(Px, Py, R, G, B);
		const double W = (Dx ? Tx : 1.0 - Tx) * (Dy ? Ty : 1.0 - Ty);
		Acc.R += W * R;
		Acc.G += W * G;
		Acc.B += W * B;
	}
	return Acc;
}

/** A view out of the sky as a camera sees it (rectilinear, `Fov` degrees across), tone-mapped like the engine would. */
std::vector<uint8_t> SkyView(const Image& Sky, int W, int H, double Fov, const Vec3& Forward, double Exposure)
{
	const Vec3 Fwd = AetherSpace::Normalized(Forward);
	const Vec3 Right = AetherSpace::Normalized(AetherSpace::Cross(AetherSpace::kUp, Fwd), Vec3{0.0, 1.0, 0.0});
	const Vec3 Up = AetherSpace::Cross(Fwd, Right);
	const double TanH = std::tan(AetherSpace::DegToRad(Fov) * 0.5);
	const double TanV = TanH * static_cast<double>(H) / static_cast<double>(W);
	std::vector<uint8_t> Out(static_cast<size_t>(W) * static_cast<size_t>(H) * 3U);
	ParallelRows(H, [&](int Y) {
		for (int X = 0; X < W; ++X)
		{
			const double Sx = (static_cast<double>(X) + 0.5) / static_cast<double>(W) * 2.0 - 1.0;
			const double Sy = 1.0 - (static_cast<double>(Y) + 0.5) / static_cast<double>(H) * 2.0;
			const Vec3 D = AetherSpace::Normalized(Fwd + Right * (Sx * TanH) + Up * (Sy * TanV));
			const Rgb C = SampleEquirect(Sky, D);
			const size_t O = (static_cast<size_t>(Y) * static_cast<size_t>(W) + static_cast<size_t>(X)) * 3U;
			Out[O + 0] = AetherSpace::ToSrgb8(C.R * Exposure);
			Out[O + 1] = AetherSpace::ToSrgb8(C.G * Exposure);
			Out[O + 2] = AetherSpace::ToSrgb8(C.B * Exposure);
		}
	});
	return Out;
}

/** A star ball as the engine will show it: the map on a sphere, limb darkening, an emissive gain, bloom, the corona behind. */
std::vector<uint8_t> SunBall(const Image& Map, const Image& Corona, int N, double Gain, double Turn, double SphereFrac)
{
	std::vector<double> Lin(static_cast<size_t>(N) * static_cast<size_t>(N) * 3U, 0.0);
	const double RadiusPx = static_cast<double>(N) * 0.5 * 0.16;
	// Corona behind: the picture is 1/0.16 as wide as the disc.
	ParallelRows(N, [&](int Y) {
		for (int X = 0; X < N; ++X)
		{
			const double U = (static_cast<double>(X) + 0.5) / static_cast<double>(N) * 2.0 - 1.0;
			const double V = (static_cast<double>(Y) + 0.5) / static_cast<double>(N) * 2.0 - 1.0;
			const size_t O = (static_cast<size_t>(Y) * static_cast<size_t>(N) + static_cast<size_t>(X)) * 3U;
			// Corona sprite (additive).
			// The corona picture's own disc is 0.16 of its half-width: scale it so that disc is the sphere.
			const double Cs = SphereFrac / 0.16;
			const int Cx = static_cast<int>(((U / Cs + 1.0) * 0.5) * static_cast<double>(Corona.Width));
			const int Cy = static_cast<int>(((V / Cs + 1.0) * 0.5) * static_cast<double>(Corona.Height));
			if (Cx >= 0 && Cy >= 0 && Cx < Corona.Width && Cy < Corona.Height)
			{
				double R = 0.0;
				double G = 0.0;
				double B = 0.0;
				Corona.Get(Cx, Cy, R, G, B);
				Lin[O + 0] += R * 0.22;
				Lin[O + 1] += G * 0.22;
				Lin[O + 2] += B * 0.22;
			}
			// The sphere.
			const double Px = U / SphereFrac;
			const double Py = -V / SphereFrac;
			const double Rr2 = Px * Px + Py * Py;
			if (Rr2 < 1.0)
			{
				const double Pz = std::sqrt(1.0 - Rr2);
				// Turn the sphere (longitude) so different spots face us.
				const double Ca = std::cos(Turn);
				const double Sa = std::sin(Turn);
				const Vec3 Dir{Pz * Ca - Px * Sa, Pz * Sa + Px * Ca, Py};
				const Rgb C = SampleEquirect(Map, Dir);
				// Limb darkening, a standard law: I(mu) = 1 - u (1 - mu), with u about 0.6.
				const double Mu = Pz;
				const double Limb = 1.0 - 0.62 * (1.0 - Mu);
				Lin[O + 0] = C.R * Gain * Limb;
				Lin[O + 1] = C.G * Gain * Limb;
				Lin[O + 2] = C.B * Gain * Limb;
			}
		}
	});
	(void)RadiusPx;
	// Bloom: a wide soft blur of what is brighter than 1, added back (what the engine's post-process does).
	std::vector<double> Bright(Lin.size(), 0.0);
	for (size_t I = 0; I < Lin.size(); ++I)
	{
		Bright[I] = std::max(0.0, Lin[I] - 0.9);
	}
	auto Blur = [&](const std::vector<double>& Src, int Radius) {
		std::vector<double> Tmp(Src.size(), 0.0);
		std::vector<double> Dst(Src.size(), 0.0);
		const double Norm = 1.0 / static_cast<double>(2 * Radius + 1);
		for (int Y = 0; Y < N; ++Y)
		{
			for (int C = 0; C < 3; ++C)
			{
				double Acc = 0.0;
				for (int X = -Radius; X <= Radius; ++X)
				{
					Acc += Src[(static_cast<size_t>(Y) * static_cast<size_t>(N) + static_cast<size_t>(std::max(0, std::min(N - 1, X)))) * 3U + static_cast<size_t>(C)];
				}
				for (int X = 0; X < N; ++X)
				{
					Tmp[(static_cast<size_t>(Y) * static_cast<size_t>(N) + static_cast<size_t>(X)) * 3U + static_cast<size_t>(C)] = Acc * Norm;
					const int Add = std::min(N - 1, X + Radius + 1);
					const int Sub = std::max(0, X - Radius);
					Acc += Src[(static_cast<size_t>(Y) * static_cast<size_t>(N) + static_cast<size_t>(Add)) * 3U + static_cast<size_t>(C)];
					Acc -= Src[(static_cast<size_t>(Y) * static_cast<size_t>(N) + static_cast<size_t>(Sub)) * 3U + static_cast<size_t>(C)];
				}
			}
		}
		for (int X = 0; X < N; ++X)
		{
			for (int C = 0; C < 3; ++C)
			{
				double Acc = 0.0;
				for (int Y = -Radius; Y <= Radius; ++Y)
				{
					Acc += Tmp[(static_cast<size_t>(std::max(0, std::min(N - 1, Y))) * static_cast<size_t>(N) + static_cast<size_t>(X)) * 3U + static_cast<size_t>(C)];
				}
				for (int Y = 0; Y < N; ++Y)
				{
					Dst[(static_cast<size_t>(Y) * static_cast<size_t>(N) + static_cast<size_t>(X)) * 3U + static_cast<size_t>(C)] = Acc * Norm;
					const int Add = std::min(N - 1, Y + Radius + 1);
					const int Sub = std::max(0, Y - Radius);
					Acc += Tmp[(static_cast<size_t>(Add) * static_cast<size_t>(N) + static_cast<size_t>(X)) * 3U + static_cast<size_t>(C)];
					Acc -= Tmp[(static_cast<size_t>(Sub) * static_cast<size_t>(N) + static_cast<size_t>(X)) * 3U + static_cast<size_t>(C)];
				}
			}
		}
		return Dst;
	};
	const std::vector<double> B1 = Blur(Bright, N / 60);
	const std::vector<double> B2 = Blur(Bright, N / 18);
	std::vector<uint8_t> Out(Lin.size());
	for (size_t I = 0; I < Lin.size(); ++I)
	{
		const double L = Lin[I] + 0.32 * B1[I] + 0.42 * B2[I];
		// ACES-like filmic shoulder.
		const double Mapped = (L * (2.51 * L + 0.03)) / (L * (2.43 * L + 0.59) + 0.14);
		Out[I] = AetherSpace::ToSrgb8(Mapped);
	}
	return Out;
}
} // namespace

int main(int Argc, char** Argv)
{
	const std::string Out = Argc > 1 ? Argv[1] : "./sky_preview";
	const int W = Argc > 2 ? std::atoi(Argv[2]) : 8192;
	const int H = W / 2;
	const int Factor = std::max(1, W / 2048);
	std::printf("threads %u, size %d x %d\n", std::thread::hardware_concurrency(), W, H);

	Clock::time_point T = Clock::now();
	SkyParams SP;
	SP.Width = W;
	SP.Height = H;
	SP.Seed = 2026U;
	const Image Sky = MakeSkyMap(SP);
	std::printf("sky map: %.1f s\n", Since(T));
	{
		int Ow = 0;
		int Oh = 0;
		WritePpm(Out + "/sky_full.ppm", 0, 0, {});
		const std::vector<uint8_t> Down = Downsample(Sky, Factor, Ow, Oh);
		WritePpm(Out + "/sky_full.ppm", Ow, Oh, Down);
		const int Cw = std::min(1600, W);
		const int Ch = std::min(900, H);
		WritePpm(Out + "/sky_crop_1to1.ppm", Cw, Ch, Crop(Sky, std::max(0, W / 2 - Cw), std::max(0, H / 2 - Ch / 2), Cw, Ch));
		// Views out of the sky: toward the band's core, and toward a quiet patch.
		WritePpm(Out + "/sky_view_core.ppm", 1600, 900, SkyView(Sky, 1600, 900, 85.0, Vec3{0.62, 0.55, 0.02}, 1.0));
		WritePpm(Out + "/sky_view_far.ppm", 1600, 900, SkyView(Sky, 1600, 900, 85.0, Vec3{-0.8, 0.3, 0.45}, 1.0));
	}

	const double Kelvins[3] = {3400.0, 5800.0, 11000.0};
	const char* Names[3] = {"red", "yellow", "blue"};
	for (int I = 0; I < 3; ++I)
	{
		T = Clock::now();
		SunParams Sp;
		Sp.Width = W;
		Sp.Height = H;
		Sp.Seed = 7U + static_cast<uint32_t>(I) * 31U;
		Sp.Kelvin = Kelvins[I];
		Sp.Activity = I == 1 ? 1.2 : 0.8;
		const Image Sun = MakeSunMap(Sp);
		std::printf("sun %s map: %.1f s\n", Names[I], Since(T));
		const Image Corona = MakeCorona(2048, 31U + static_cast<uint32_t>(I), Kelvins[I]);
		const std::string Base = Out + "/sun_" + Names[I];
		int Ow = 0;
		int Oh = 0;
		const std::vector<uint8_t> Down = Downsample(Sun, Factor, Ow, Oh);
		WritePpm(Base + "_map.ppm", Ow, Oh, Down);
		WritePpm(Base + "_ball.ppm", 1400, 1400, SunBall(Sun, Corona, 1400, 1.35, 0.4 + static_cast<double>(I), 0.42));
		WritePpm(Base + "_system.ppm", 1400, 1400, SunBall(Sun, Corona, 1400, 1.35, 1.2 + static_cast<double>(I), 0.16));
		if (I == 1)
		{
			const int Cw = std::min(1600, W);
			const int Ch = std::min(900, H);
			WritePpm(Base + "_crop_1to1.ppm", Cw, Ch, Crop(Sun, W / 2 - Cw / 2, H / 2 - Ch / 2, Cw, Ch));
		}
	}
	std::printf("done\n");
	return 0;
}
